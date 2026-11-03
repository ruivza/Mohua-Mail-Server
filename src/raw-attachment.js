import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MailParser } from "mailparser";
// Extract only the requested MIME attachment from the durable original, without another provider fetch.
export function rawAttachment(raw, index) {
  return Readable.from(
    (async function* () {
      const parser = new MailParser({
        skipHtmlToText: true,
        skipTextToHtml: true,
        skipImageLinks: true,
      });
      let failure;
      const pumping = pipeline(raw, parser).catch((e) => {
        failure = e;
        parser.destroy(e);
      });
      let seen = 0,
        found = false;
      try {
        for await (const part of parser) {
          if (part.type !== "attachment") continue;
          const selected = seen++ === index;
          try {
            for await (const chunk of part.content) {
              if (selected) yield chunk;
            }
          } finally {
            part.release();
          }
          if (selected) {
            found = true;
            break;
          }
        }
        if (!found) {
          if (failure) throw failure;
          throw Object.assign(Error("Attachment not found in saved original"), { status: 404 });
        }
      } finally {
        raw.destroy();
        parser.destroy();
        await pumping;
      }
    })(),
  );
}
