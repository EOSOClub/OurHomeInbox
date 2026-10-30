# OurHomeInbox

Reads bills and payment confirmations from your email and hands them to
[Our Home](https://github.com/EOSOClub/OurHome). It is meant to replace the
Paperless-ngx bill import.

**Status: early development.** It loads its settings and checks that it can
reach a Proton Mail folder through Proton Mail Bridge. It does not read bills yet.

## What it will do

- Connect to Gmail, Microsoft (Outlook.com and Microsoft 365) and Proton Mail
  (through Proton Mail Bridge).
- Walk you through setup: the folder to make and the filter to add, for your
  mail provider.
- Read each bill email, its attachments and, where it is safe, the links in it.
- Show everything it captured from an email next to the values it picked out,
  so you can see what was available and where each value came from.
- Offer an API, so an AI assistant can help with setup and run it.

Photos of paper bills and text recognition (OCR) come later.

## Related

- [Our Home](https://github.com/EOSOClub/OurHome), the website and server
- [OurHomeServices](https://github.com/EOSOClub/OurHomeServices), the supporting
  Docker stacks (including Proton Mail Bridge)

## License

AGPL-3.0, the same as the rest of Our Home.
