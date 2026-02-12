# linkcheck

by [yeth.dev](https://yeth.dev)

Checks URLs against 15 school/district web filters at once and shows you which are blocked and unblocked. Runs in parallel so results come back really fast.

Supports FortiGuard, Lightspeed, Palo Alto, Blocksi (web and AI), Linewize, Cisco Umbrella, Securly, GoGuardian, LanSchool, ContentKeeper, Aristotle K-12, Senso Cloud, Deledao, and iBoss.

## installation

Requires Node 18 or higher

```
npm install
npm start
```

The filter engine files themselves aren't in this repo. Each one lives in `filters/`. Find the filters from breadbb [here](https://cdn.discordapp.com/attachments/1350571419041529990/1469140502116040746/filters.zip?ex=698dd377&is=698c81f7&hm=31270dff1b157d340e6765f1110902c726ffc11812f8430661d7ec4c38c1c893&) (contentkeeper got patched) Download that, put it in root, and replace the filters folder with it.

## endpoints

`GET /api/check-stream?url=<url>` SSE stream, fires one event per engine as results come in

`GET /api/batch?urls=<json>` checks multiple URLs in parallel, also SSE

`GET /api/status` health check

Rate limited to 15 single / 5 batch requests per 2 minutes per IP.

## legacy discord mode

The way this used to work is it used playwright to talk to gn-math or similar in discord, then would show the results here once it was finished. This was slow, but it worked. Use `web-legacy` to do that again since bots like LinkLens exist now

```
node src/index.js check <url>
node src/index.js file urls.txt
node src/index.js interactive
node src/index.js web-legacy --port 3000
```

## license

Free to use, modify, and deploy. Credit to [yeth.dev](https://yeth.dev) is required. See [LICENSE](LICENSE).

used to be hosted at https://check.yeth.dev/ but once contentkeeper patched it i chose to discontinue it. still occasionally update the repo tho
