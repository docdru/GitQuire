//! Symlink write-through resolution, ported from Codex's
//! `utils/path-utils/src/lib.rs` `resolve_symlink_write_paths` (Apache-2.0).
//!
//! A dotfile-managed harness config is often a symlink into a stow/chezmoi
//! repo. OpenKnowledge's current write replaces that symlink with a regular
//! file and orphans the repo copy; this resolves the chain to its real target
//! so the caller writes *through* the symlink instead. The actual atomic
//! tmp+rename stays on OpenKnowledge's existing write spine — this module only
//! decides *where* to write.
//!
//! Codex's version normalizes the root through its `AbsolutePathBuf`; OpenKnowledge
//! always passes an absolute config path, so that step is dropped. Relative
//! symlink targets are still resolved against the link's parent, and a chain
//! that cycles (or whose metadata can't be read) falls back to the original
//! path with no read target — the caller then writes a fresh regular file there,
//! breaking the cycle.

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

/// Where to read the existing config from and where to write the new one.
///
/// `read_path` is `None` when the chain could not be safely resolved (a cycle
/// or a link/metadata error); in that case `write_path` is the original path,
/// and writing a regular file there intentionally breaks the broken link.
pub struct SymlinkWritePaths {
    pub read_path: Option<PathBuf>,
    pub write_path: PathBuf,
}

/// Follow `path`'s symlink chain to the first non-symlink target, guarding
/// against cycles via a visited set. There is no fixed max-hop count.
pub fn resolve_symlink_write_paths(path: &Path) -> io::Result<SymlinkWritePaths> {
    let root = path.to_path_buf();
    let mut current = root.clone();
    let mut visited = HashSet::new();

    loop {
        let meta = match std::fs::symlink_metadata(&current) {
            Ok(meta) => meta,
            // A not-yet-created target is a normal first-write: write there.
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                return Ok(SymlinkWritePaths {
                    read_path: Some(current.clone()),
                    write_path: current,
                });
            }
            Err(_) => return Ok(broken_chain(root)),
        };

        if !meta.file_type().is_symlink() {
            return Ok(SymlinkWritePaths {
                read_path: Some(current.clone()),
                write_path: current,
            });
        }

        // Re-seeing a path means the chain loops back on itself.
        if !visited.insert(current.clone()) {
            return Ok(broken_chain(root));
        }

        let target = match std::fs::read_link(&current) {
            Ok(target) => target,
            Err(_) => return Ok(broken_chain(root)),
        };

        current = if target.is_absolute() {
            target
        } else if let Some(parent) = current.parent() {
            parent.join(target)
        } else {
            return Ok(broken_chain(root));
        };
    }
}

fn broken_chain(root: PathBuf) -> SymlinkWritePaths {
    SymlinkWritePaths {
        read_path: None,
        write_path: root,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    /// Mirror of OpenKnowledge's tmp+rename atomic write so the symlink tests
    /// exercise the same replace-vs-write-through behavior the real spine does:
    /// renaming a fresh file onto a path replaces a symlink there, but renaming
    /// onto a resolved real target leaves the original symlink intact.
    fn atomic_write(path: &Path, contents: &str) {
        let parent = path.parent().expect("write path has a parent");
        let tmp = tempfile::NamedTempFile::new_in(parent).expect("tmp file");
        fs::write(tmp.path(), contents).expect("write tmp");
        tmp.persist(path).expect("rename onto target");
    }

    #[test]
    fn regular_file_resolves_to_itself() {
        let dir = tempdir().expect("tmpdir");
        let path = dir.path().join("config.toml");
        fs::write(&path, "x = 1\n").expect("seed");

        let resolved = resolve_symlink_write_paths(&path).expect("resolve");
        assert_eq!(resolved.read_path.as_deref(), Some(path.as_path()));
        assert_eq!(resolved.write_path, path);
    }

    #[test]
    fn missing_file_resolves_to_itself() {
        let dir = tempdir().expect("tmpdir");
        let path = dir.path().join("config.toml");

        let resolved = resolve_symlink_write_paths(&path).expect("resolve");
        assert_eq!(resolved.read_path.as_deref(), Some(path.as_path()));
        assert_eq!(resolved.write_path, path);
    }

    #[cfg(unix)]
    #[test]
    fn writes_through_symlink_chain_to_real_target() {
        use std::os::unix::fs::symlink;

        let home = tempdir().expect("home");
        let target_dir = tempdir().expect("target dir");
        let target_path = target_dir.path().join("config.toml");
        let link_path = home.path().join("config-link.toml");
        let config_path = home.path().join("config.toml");

        symlink(&target_path, &link_path).expect("link -> target");
        symlink("config-link.toml", &config_path).expect("config -> link");

        let resolved = resolve_symlink_write_paths(&config_path).expect("resolve");
        assert_eq!(resolved.write_path, target_path);
        assert_eq!(resolved.read_path.as_deref(), Some(target_path.as_path()));

        atomic_write(&resolved.write_path, "model = \"x\"\n");

        let meta = fs::symlink_metadata(&config_path).expect("config metadata");
        assert!(
            meta.file_type().is_symlink(),
            "the user's symlink must survive a write-through"
        );
        assert_eq!(
            fs::read_to_string(&target_path).expect("read target"),
            "model = \"x\"\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn breaks_cycle_into_regular_file() {
        use std::os::unix::fs::symlink;

        let home = tempdir().expect("home");
        let link_a = home.path().join("a.toml");
        let link_b = home.path().join("b.toml");
        let config_path = home.path().join("config.toml");

        symlink("b.toml", &link_a).expect("a -> b");
        symlink("a.toml", &link_b).expect("b -> a");
        symlink("a.toml", &config_path).expect("config -> a");

        let resolved = resolve_symlink_write_paths(&config_path).expect("resolve");
        assert!(resolved.read_path.is_none());
        assert_eq!(resolved.write_path, config_path);

        atomic_write(&resolved.write_path, "model = \"x\"\n");

        let meta = fs::symlink_metadata(&config_path).expect("config metadata");
        assert!(
            !meta.file_type().is_symlink(),
            "a cyclic chain must collapse to a regular file"
        );
        assert_eq!(
            fs::read_to_string(&config_path).expect("read config"),
            "model = \"x\"\n"
        );
    }
}
