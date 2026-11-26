import { HocuspocusProvider, WebSocket, Y } from './deps.mjs';

export class Editor {
  constructor(session, wikiPath, docName) {
    this.session = session;
    this.docName = docName;
    this.doc = new Y.Doc();
    this.fragment = this.doc.getXmlFragment('default');
    this.source = this.doc.getText('source');
    this.disconnects = 0;
    this.errors = [];
    const cookie = session.cookieHeader();
    const origin = session.base;
    class CookieSocket extends WebSocket {
      constructor(url, protocols) {
        super(url, protocols, { headers: { cookie, origin } });
      }
    }
    const url = `${session.base.replace(/^http/, 'ws')}${wikiPath}collab`;
    this.provider = new HocuspocusProvider({
      url,
      name: docName,
      document: this.doc,
      WebSocketPolyfill: CookieSocket,
      onDisconnect: () => {
        this.disconnects++;
      },
      onAuthenticationFailed: ({ reason }) => this.errors.push(`auth: ${reason}`),
    });
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
    this.provider.destroy();
    this.doc.destroy();
  }
}
