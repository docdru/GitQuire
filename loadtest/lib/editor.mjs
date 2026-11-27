import { HocuspocusProvider, WebSocket, Y } from './deps.mjs';

export class Editor {
  constructor(session, wikiPath, docName) {
    this.session = session;
    this.wikiPath = wikiPath;
    this.docName = docName;
    this.disconnects = 0;
    this.reopens = 0;
    this.replayed = 0;
    this.errors = [];
    this.expected = [];
    this.docListeners = [];
    this.providerListeners = [];
    this.destroyed = false;
    this.connect();
  }

  connect() {
    this.doc = new Y.Doc();
    this.fragment = this.doc.getXmlFragment('default');
    this.source = this.doc.getText('source');
    const cookie = this.session.cookieHeader();
    const origin = this.session.base;
    class CookieSocket extends WebSocket {
      constructor(url, protocols) {
        super(url, protocols, { headers: { cookie, origin } });
        this.on('error', () => {});
      }
    }
    const url = `${this.session.base.replace(/^http/, 'ws')}${this.wikiPath}collab`;
    const provider = new HocuspocusProvider({
      url,
      name: this.docName,
      document: this.doc,
      WebSocketPolyfill: CookieSocket,
      onDisconnect: () => {
        if (this.provider !== provider || this.destroyed || !wasSynced) return;
        this.disconnects++;
        this.reopen();
      },
      onAuthenticationFailed: ({ reason }) => this.errors.push(`auth: ${reason}`),
    });
    this.provider = provider;
    let wasSynced = false;
    provider.on('synced', () => {
      if (this.provider !== provider) return;
      wasSynced = true;
      this.replayMissing();
    });
    for (const fn of this.docListeners) fn(this.doc);
    for (const fn of this.providerListeners) fn(this.provider);
  }

  reopen() {
    const old = this.provider;
    const oldDoc = this.doc;
    this.reopens++;
    this.connect();
    setImmediate(() => {
      try {
        old.destroy();
      } catch {}
      oldDoc.destroy();
    });
  }

  replayMissing() {
    if (this.reopens === 0) return;
    const text = this.plain();
    for (const marker of this.expected) {
      if (!text.includes(marker)) {
        this.appendToLast(` ${marker} `);
        this.replayed++;
      }
    }
  }

  onDoc(fn) {
    this.docListeners.push(fn);
    fn(this.doc);
  }

  onProvider(fn) {
    this.providerListeners.push(fn);
    fn(this.provider);
  }

  synced(timeoutMs = 30_000) {
    if (this.provider.isSynced) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sync timeout ${this.docName}`)), timeoutMs);
      this.provider.on('synced', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  typeParagraph(text) {
    const paragraph = new Y.XmlElement('paragraph');
    const node = new Y.XmlText();
    node.applyDelta([{ insert: text }]);
    paragraph.insert(0, [node]);
    this.fragment.push([paragraph]);
  }

  appendToLast(text) {
    const last = this.fragment.get(this.fragment.length - 1);
    const node = last instanceof Y.XmlElement ? last.get(0) : undefined;
    if (node instanceof Y.XmlText) node.insert(node.length, text);
    else this.typeParagraph(text);
  }

  plain() {
    return this.fragment.toString();
  }

  contains(marker) {
    return this.fragment.toString().includes(marker);
  }

  destroy() {
    this.destroyed = true;
    try {
      this.provider.destroy();
    } catch {
      this.errors.push('destroy before connect');
    }
    this.doc.destroy();
  }
}
