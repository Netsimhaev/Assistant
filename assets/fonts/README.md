# Fonts embedded in produced PDFs

Used by `src/production/render-pdf.ts` (`loadPdfAssets`), embedded in every
PDF as `data:` URLs. `DOCUMENT_FONT_PATH` names the Hebrew Regular file; the
other three must sit beside it under these exact names.

Noto Sans Hebrew covers Hebrew only (no digits, no Latin, no `.`/`,`), so
Noto Sans (Latin) is embedded alongside it; the CSS stack falls through per glyph.

Both families: SIL Open Font License 1.1, Copyright 2022 The Noto Project
Authors. Licence texts: `OFL.txt` (notofonts/hebrew), `OFL-NotoSans.txt`
(notofonts/latin-greek-cyrillic). Static hinted TTFs, downloaded 2026-11-04.

| File | Source URL | SHA-256 |
|---|---|---|
| NotoSansHebrew-Regular.ttf | https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansHebrew/hinted/ttf/NotoSansHebrew-Regular.ttf | cdefaf8efd47045f6820928eba84db5bed7557539328952b5f828315485e02ee |
| NotoSansHebrew-Bold.ttf | https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansHebrew/hinted/ttf/NotoSansHebrew-Bold.ttf | da9226e886c245a7e11673c24dec82bded64d8574c1e1f03983bf89297d2aaa8 |
| NotoSans-Regular.ttf | https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf | 478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823 |
| NotoSans-Bold.ttf | https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSans/hinted/ttf/NotoSans-Bold.ttf | 1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913 |
| OFL.txt | https://raw.githubusercontent.com/notofonts/hebrew/main/OFL.txt | e08036dbb38d9e7a033a721e0ca60befde2ed9d1a8075922dbd3429093dd793b |
| OFL-NotoSans.txt | https://raw.githubusercontent.com/notofonts/latin-greek-cyrillic/main/OFL.txt | cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a |
