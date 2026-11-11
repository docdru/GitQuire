import type { GateLogger } from './access-gate.ts';
import type { MailConfig, MailMessage } from './mail.ts';
import { type Mention, type MentionIndex, type MentionReadStore, mentionsFor } from './mentions.ts';

const MAX_MAILS_PER_PERSON_PER_ROUND = 10;

export interface MentionMailerDeps {
  index: MentionIndex;
  store: MentionReadStore;
  config: MailConfig;
  send: (config: MailConfig, message: MailMessage) => Promise<void>;
  log: Pick<GateLogger, 'warn'>;
}

export interface MentionMailer {
  round: () => Promise<number>;
}

export function pageLink(externalUrl: string | undefined, docName: string): string | undefined {
  if (externalUrl === undefined) return undefined;
  const route = docName.split('/').map(encodeURIComponent).join('/');
  return `${externalUrl}/#/${route}`;
}

export function mentionMail(
  config: Pick<MailConfig, 'externalUrl'>,
  to: string,
  mention: Mention,
): MailMessage {
  const who = mention.author.name ?? mention.author.login ?? 'Someone';
  const page = mention.docName.slice(mention.docName.lastIndexOf('/') + 1);
  const link = pageLink(config.externalUrl, mention.docName);
  const lines = [
    `${who} mentioned you in "${page}".`,
    '',
    `On the text: "${mention.quote}"`,
    '',
    mention.body,
  ];
  if (link !== undefined) lines.push('', `Open the page: ${link}`);
  lines.push('', 'You get this mail because you turned on email for mentions in GitQuire.');
  return { to, subject: `${who} mentioned you in ${page}`, text: `${lines.join('\n')}\n` };
}

export function createMentionMailer(deps: MentionMailerDeps): MentionMailer {
  let running = false;

  async function round(): Promise<number> {
    if (running) return 0;
    running = true;
    let sent = 0;
    try {
      const subscribers = deps.store.subscribers();
      if (subscribers.length === 0) return 0;
      const all = deps.index.all();
      for (const subscriber of subscribers) {
        const mailed = deps.store.mailedIds(subscriber.id);
        const read = deps.store.readIds(subscriber.id);
        const due = mentionsFor(subscriber, all)
          .filter((mention) => !mailed.has(mention.id) && !read.has(mention.id))
          .slice(0, MAX_MAILS_PER_PERSON_PER_ROUND);
        for (const mention of due) {
          await deps.send(deps.config, mentionMail(deps.config, subscriber.email, mention));
          deps.store.markMailed(subscriber.id, [mention.id]);
          sent += 1;
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      deps.log.warn({ reason }, '[gitquire-mail] could not send a mention email');
    } finally {
      running = false;
    }
    return sent;
  }

  return { round };
}
