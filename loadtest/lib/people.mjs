import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import { Editor } from './editor.mjs';
import { rng } from './generate.mjs';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz     ';

export class MarkerBoard {
  constructor(recorder, name = 'edit.propagate') {
    this.recorder = recorder;
    this.name = name;
    this.pending = new Map();
    this.all = [];
  }

  sent(marker) {
    this.pending.set(marker, performance.now());
    this.all.push(marker);
  }

  watch(editor) {
    let queued = false;
    editor.doc.on('update', () => {
      if (queued) return;
      queued = true;
      setImmediate(() => {
        queued = false;
        if (this.pending.size === 0) return;
        const text = editor.plain();
        for (const [marker, at] of this.pending) {
          if (text.includes(marker)) {
            this.recorder.add(this.name, performance.now() - at);
            this.pending.delete(marker);
          }
        }
      });
    });
  }

  expire(olderThanMs = 30_000) {
    const now = performance.now();
    for (const [marker, at] of this.pending) {
      if (now - at > olderThanMs) {
        this.recorder.count('edit.propagate.timeout');
        this.pending.delete(marker);
      }
    }
  }
}

export class Typist {
  constructor({
    session,
    wikiPath,
    docName,
    recorder,
    board,
    seed,
    think = [2000, 10000],
    keyMs = [60, 160],
  }) {
    this.session = session;
    this.wikiPath = wikiPath;
    this.docName = docName;
    this.recorder = recorder;
    this.board = board;
    this.r = rng(seed);
    this.think = think;
    this.keyMs = keyMs;
    this.running = false;
    this.count = 0;
    this.markers = [];
  }

  async open() {
    const started = performance.now();
    this.editor = new Editor(this.session, this.wikiPath, this.docName);
    await this.editor.synced();
    this.recorder.add('page.open', performance.now() - started);
    this.editor.provider.on('unsyncedChanges', ({ number }) => {
      if (number === 0 && this.ackFrom !== undefined) {
        this.recorder.add('edit.ack', performance.now() - this.ackFrom);
        this.ackFrom = undefined;
      }
    });
    this.editor.typeParagraph(`${this.session.login} notes `);
  }

  async run(until) {
    this.running = true;
    while (this.running && Date.now() < until) {
      await wait(this.think[0] + this.r.int(this.think[1] - this.think[0]));
      if (!this.running || Date.now() >= until) break;
      const length = 1 + this.r.int(30);
      let text = '';
      for (let i = 0; i < length; i++) text += this.r.pick(LETTERS.split(''));
      for (let i = 0; i < text.length; i += 1 + this.r.int(4)) {
        this.keystroke(text.slice(i, i + 1 + this.r.int(4)));
        await wait(this.keyMs[0] + this.r.int(this.keyMs[1] - this.keyMs[0]));
      }
      const marker = `zq${this.session.login}x${this.count++}q`;
      this.markers.push(marker);
      this.board?.sent(marker);
      this.keystroke(` ${marker} `);
      if (this.r.next() < 0.08) this.editor.typeParagraph(`${this.session.login} more `);
    }
  }

  keystroke(text) {
    if (this.ackFrom === undefined) this.ackFrom = performance.now();
    this.editor.appendToLast(text);
    this.recorder.count('edit.keystrokes');
  }

  stop() {
    this.running = false;
  }

  close() {
    this.editor?.destroy();
  }
}

export class Reader {
  constructor({ session, wikiPath, docNames, recorder, seed, think = [2000, 10000], hubs = [] }) {
    this.session = session;
    this.wikiPath = wikiPath;
    this.docNames = docNames;
    this.recorder = recorder;
    this.r = rng(seed);
    this.think = think;
    this.hubs = hubs;
    this.running = false;
  }

  async timed(name, method, path, body) {
    try {
      const res = await this.session.call(method, this.wikiPath + path, body);
      this.recorder.count(`requests`);
      if (res.status >= 400) {
        this.recorder.count(`errors`);
        this.recorder.count(`error.${name}.${res.status}`);
      } else this.recorder.add(`api.${name}`, res.ms);
      return res;
    } catch (err) {
      this.recorder.count('requests');
      this.recorder.count('errors');
      this.recorder.count(`error.${name}.${err.code ?? 'fetch'}`);
    }
  }

  async readPage() {
    const docName = this.r.pick(this.docNames);
    const started = performance.now();
    const editor = new Editor(this.session, this.wikiPath, docName);
    try {
      await editor.synced();
      this.recorder.add('page.open', performance.now() - started);
      await this.timed('backlinks', 'GET', `api/backlinks?docName=${encodeURIComponent(docName)}`);
      await wait(3000 + this.r.int(12000));
    } catch {
      this.recorder.count('errors');
      this.recorder.count('error.page.open');
    } finally {
      editor.destroy();
    }
  }

  async step() {
    const roll = this.r.next();
    if (roll < 0.5) return this.readPage();
    if (roll < 0.7) {
      const word = this.r.pick([
        'budget',
        'roadmap',
        'incident',
        'onboarding',
        'review',
        'Topic 001',
      ]);
      return this.timed('search', 'GET', `api/search?query=${encodeURIComponent(word)}&limit=20`);
    }
    if (roll < 0.8) return this.timed('documents', 'GET', 'api/documents');
    if (roll < 0.88) return this.timed('mentions', 'GET', 'api/gitquire/mentions');
    if (roll < 0.95) {
      const docName = this.hubs.length > 0 ? this.r.pick(this.hubs) : this.r.pick(this.docNames);
      return this.timed('backlinks', 'GET', `api/backlinks?docName=${encodeURIComponent(docName)}`);
    }
    return this.timed(
      'linkgraph',
      'GET',
      `api/link-graph?docName=${encodeURIComponent(this.r.pick(this.docNames))}&degrees=1`,
    );
  }

  async run(until) {
    this.running = true;
    while (this.running && Date.now() < until) {
      await wait(this.think[0] + this.r.int(this.think[1] - this.think[0]));
      if (!this.running || Date.now() >= until) break;
      await this.step();
    }
  }

  stop() {
    this.running = false;
  }
}
