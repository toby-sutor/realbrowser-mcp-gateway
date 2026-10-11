# Third-party notices

RealBrowser MCP Gateway itself is MIT licensed (see [LICENSE](LICENSE)). This file lists the third-party
components that ship with it or that it needs at runtime, and the tools used only for development and tests.
Licenses were read from the packages themselves (their `package.json` and license files), not from memory.

## Shipped in this repository or in the add-on file

### Defuddle 0.19.4 (MIT)

- What: the page-content extractor used by the browser add-on.
- Where: `extension/vendor/defuddle.full.js`, unmodified, with its license text in
  `extension/vendor/LICENSE.defuddle` and the pinned version, registry integrity and file hashes in
  `extension/vendor/VENDOR.lock.json`. It is part of the add-on file (`.xpi`), which also carries this file and
  `LICENSE` at its root. `node tools/vendor.mjs --check`
  verifies that the files match the lock.
- Copyright (c) 2025 Steph Ango (@kepano). Full text below.

The file is a single minified bundle, built by the Defuddle project from its own code and from the packages below.
They were identified from the names left in the bundle and from the dependency list of `defuddle@0.19.4` on the npm
registry; the exact versions inside the bundle are not recorded in it, so the version column gives the range that
Defuddle 0.19.4 declares. Each package's own copyright and permission text follows, as it appears in the package.

| Bundled package | Declared range | License |
|---|---|---|
| Turndown | ^7.2.0 | MIT |
| Temml | ^0.13.3 | MIT |
| mathml-to-latex | ^1.8.0 | MIT |
| @xmldom/xmldom (through mathml-to-latex) | ^0.9.10 | MIT |

Defuddle's license:

```
MIT License

Copyright (c) 2025 Steph Ango (@kepano)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### Turndown (MIT)

```
MIT License

Copyright (c) 2017 Dom Christie

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### Temml (MIT)

Temml describes itself as a fork of KaTeX (MIT, Copyright (c) 2013-2020 Khan Academy and other contributors).
The text below is Temml's own license text, as the package carries it.

```
The MIT License (MIT)

Copyright (c) 2020 Ron Kok

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### mathml-to-latex (MIT)

```
MIT License

Copyright (c) 2020 Alexandre Nunes

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### @xmldom/xmldom (MIT)

A dependency of mathml-to-latex. The text is the same for the 0.8 and the 0.9 line.

```
Copyright 2019 - present Christopher J. Brody and other contributors, as listed in: https://github.com/xmldom/xmldom/graphs/contributors
Copyright 2012 - 2017 @jindw <jindw@xidea.org> and other contributors, as listed in: https://github.com/jindw/xmldom/graphs/contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Required at runtime on your machine, not shipped in this repository

### ws 8.22.0 (MIT)

- What: WebSocket server library of the daemon. It is the only runtime dependency in `package.json`.
- Where: installed by `npm ci` into `node_modules/ws` from the registry; the exact version and integrity hash are
  in `package-lock.json`. It is not copied into this repository and not part of the add-on file.
- Copyright (c) 2011 Einar Otto Stangvik, (c) 2013 Arnout Kazemier and contributors, (c) 2016 Luigi Pinca and
  contributors. License text as in the package:

```
Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### Programs of your system

The gateway runs on Node.js (MIT licensed project, provided by you) and Python 3 (standard library only for the
command line client). The optional desktop notification helper uses PyGObject (`gi`) and the system's D-Bus,
and the optional sound uses `pw-play`; the browser is Waterfox, LibreWolf or another Firefox-family browser. None of
these is shipped here; their licenses are those of your distribution's packages.

## Reference data

The table of shared domain names in `extension/shared/suffixes.js` was written for this project and checked
against the Public Suffix List (publicsuffix.org, MPL-2.0). It is not a copy of that list and covers only part
of it.

## Development and tests only (not shipped, not needed to run the gateway)

| Component | License | How it is used |
|---|---|---|
| `@types/node` 24.19.1 | MIT | type definitions for `npm run lint`, from `devDependencies` |
| `@types/firefox-webext-browser` 143.0.1 | MIT | type definitions for `npm run lint`, from `devDependencies` |
| `@types/ws` 8.18.2 | MIT | type definitions for `npm run lint`, from `devDependencies` |
| `undici-types` 7.24.6 | MIT | pulled in by `@types/node` |
| TypeScript 7.0.2 | Apache-2.0 | type checker for `npm run lint`, from `devDependencies` (exact version, in `package-lock.json`) |
| `web-ext` 10.7.0 | MPL-2.0 | starts a headless Firefox for the integration tests, fetched by `npx` on first use |

The versions above are those that were checked. The integration and smoke tests also drive a Firefox or Chromium
that is installed on your system; neither is shipped here.
