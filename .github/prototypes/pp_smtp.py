import os
import socketserver
import sys
import time

OUT = os.environ.get("PP_MAIL_DIR", "/tmp/pp-mail")
PORT = int(os.environ.get("PP_SMTP_PORT", "2525"))


class Handler(socketserver.StreamRequestHandler):
    def reply(self, line):
        self.wfile.write((line + "\r\n").encode())

    def handle(self):
        self.reply("220 pp-smtp ready")
        rcpt = []
        while True:
            raw = self.rfile.readline()
            if not raw:
                return
            line = raw.decode(errors="replace").rstrip("\r\n")
            verb = line.split(" ", 1)[0].upper()
            if verb in ("EHLO", "HELO"):
                self.reply("250 pp-smtp")
            elif verb == "MAIL":
                rcpt = []
                self.reply("250 ok")
            elif verb == "RCPT":
                rcpt.append(line.split(":", 1)[1].strip().strip("<>"))
                self.reply("250 ok")
            elif verb == "DATA":
                self.reply("354 go on")
                body = []
                while True:
                    part = self.rfile.readline().decode(errors="replace")
                    if part in (".\r\n", ".\n", ""):
                        break
                    body.append(part)
                os.makedirs(OUT, exist_ok=True)
                name = os.path.join(OUT, f"{time.time_ns()}.eml")
                with open(name, "w") as fh:
                    fh.write("X-PP-To: " + ",".join(rcpt) + "\n" + "".join(body))
                self.reply("250 queued")
            elif verb == "QUIT":
                self.reply("221 bye")
                return
            else:
                self.reply("250 ok")


class Fake(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Fake(("127.0.0.1", PORT), Handler) as server:
        print(f"pp-smtp on {PORT}", flush=True)
        sys.stdout.flush()
        server.serve_forever()
