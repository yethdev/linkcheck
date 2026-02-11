import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { fortiguard }      = require('../filters/fortiguard.js');
const { lightspeed }      = require('../filters/lightspeed.js');
const { palo }            = require('../filters/paloalto.js');
const { blocksiStandard } = require('../filters/blocksi.js');
const { blocksiAI }       = require('../filters/blocksi.js');
const { linewize }        = require('../filters/linewize.js');
const { cisco }           = require('../filters/cisco.js');
const { securly }         = require('../filters/securly.js');
const { goguardian }      = require('../filters/goguardian.js');
const { lanschool }       = require('../filters/lanschool.js');
const { contentkeeper }   = require('../filters/contentkeeper.js');
const { aristotlek12 }    = require('../filters/aristotle.js');
const { sensocloud }      = require('../filters/senso.js');
const { deledao }         = require('../filters/deledao.js');
const { iboss }           = require('../filters/iboss.js');

const PLATFORMS = [
  { name: 'FortiGuard',     fn: fortiguard,      returnType: 'object'  },
  { name: 'Lightspeed',     fn: lightspeed,      invertBlocked: true, domainOnly: true },
  { name: 'Palo Alto',      fn: palo,            invertBlocked: true   },
  { name: 'Blocksi Web',    fn: blocksiStandard                        },
  { name: 'Blocksi AI',     fn: blocksiAI                              },
  { name: 'Linewize',       fn: linewize                               },
  { name: 'Cisco Umbrella', fn: cisco                                  },
  { name: 'Securly',        fn: securly                                },
  { name: 'GoGuardian',     fn: goguardian                             },
  { name: 'LanSchool',      fn: lanschool,       returnType: 'special' },
  { name: 'ContentKeeper',  fn: contentkeeper,   returnType: 'object'  },
  { name: 'AristotleK12',   fn: aristotlek12,    returnType: 'object'  },
  { name: 'Senso Cloud',    fn: sensocloud                             },
  { name: 'Deledao',        fn: deledao                                },
  { name: 'iBoss',          fn: iboss                                  },
];

export const PLATFORM_NAMES = PLATFORMS.map(p => p.name);

const PER_FILTER_TIMEOUT = 10_000;

function normalise(platform, apiResult) {
  if (apiResult === 'Error' || apiResult === 'error') {
    return { status: 'error', category: 'Error' };
  }

  if (platform.returnType === 'special') {
    if (typeof apiResult === 'string') {
      // If the filter returns its own name, it means "allowed / uncategorised".
      // Any other string is a blocked-category label.
      const isAllow = apiResult === platform.name;
      return { status: isAllow ? 'unblocked' : 'blocked', category: apiResult };
    }
    if (apiResult == null) {
      return { status: 'unblocked', category: 'Uncategorized' };
    }
    return { status: 'error', category: 'Unknown' };
  }

  if (platform.returnType === 'object') {
    const cat = apiResult.category || 'Unknown';
    return { status: apiResult.blocked ? 'blocked' : 'unblocked', category: cat };
  }

  if (Array.isArray(apiResult)) {
    const cat = apiResult[0] || 'Unknown';
    const blocked = platform.invertBlocked ? !apiResult[1] : !!apiResult[1];
    return { status: blocked ? 'blocked' : 'unblocked', category: String(cat) };
  }

  if (typeof apiResult === 'string') {
    return { status: 'error', category: apiResult };
  }

  return { status: 'error', category: 'Unknown' };
}

export async function checkAllFilters(url, onResult) {
  const cleaned = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  const promises = PLATFORMS.map(async (platform) => {
    const start = Date.now();
    const filterUrl = platform.domainOnly ? cleaned.split('/')[0] : cleaned;
    try {
      const apiResult = await Promise.race([
        platform.fn(filterUrl),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), PER_FILTER_TIMEOUT)
        ),
      ]);
      const ms = Date.now() - start;
      const norm = normalise(platform, apiResult);
      const out = { name: platform.name, ...norm, ms };
      onResult(out);
    } catch (err) {
      const ms = Date.now() - start;
      onResult({
        name: platform.name,
        status: 'error',
        category: err.message === 'timeout' ? 'Timeout' : (err.message || 'Error'),
        ms,
      });
    }
  });

  await Promise.allSettled(promises);
}

const WARM_HOSTS = [
  'https://wsfgd1.fortiguard.net:3400/',
  'https://api.blocksi.net/',
  'https://service1.blocksi.net/',
  'https://talosintelligence.com/',
  'https://urlfiltering.paloaltonetworks.com/',
  'https://mvgateway.syd-1.linewize.net/',
  'https://uswest-www.securly.com/',
  'https://panther.goguardian.com/',
  'https://filter.coopacademiescloud.netsweeper.com:3431/',
  'https://ckf01.barringtonschools.org/',
  'https://filtering.senso.cloud/',
  'https://cc.deledao.com/',
  'https://cluster122287-swg.ibosscloud.com:8026/',
];

export async function warmUp() {
  const results = await Promise.allSettled(
    WARM_HOSTS.map(host =>
      fetch(host, { method: 'HEAD', signal: AbortSignal.timeout(5000) }).catch(() => {})
    )
  );
  const ok = results.filter(r => r.status === 'fulfilled').length;
  console.log('[warm-up] ' + ok + '/' + WARM_HOSTS.length + ' hosts ready');
}