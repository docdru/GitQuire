export function makeFilesDataTransfer(files: readonly File[]) {
  return {
    types: ['Files'],
    files,
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    dropEffect: 'none',
    effectAllowed: 'all',
    getData: () => '',
  };
}
