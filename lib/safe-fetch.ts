import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { request as httpsRequest } from 'node:https';

const blockedAddresses = new BlockList();

for (const [subnet, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(subnet, prefix, 'ipv4');
}

for (const [subnet, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedAddresses.addSubnet(subnet, prefix, 'ipv6');
}

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;

interface SafeResponse {
  status: number;
  headers: import('node:http').IncomingHttpHeaders;
  body: Buffer;
}

async function resolvePublicAddress(hostname: string) {
  const normalizedHost = hostname.replace(/^\[|\]$/g, '');
  const family = isIP(normalizedHost);
  const addresses = family
    ? [{ address: normalizedHost, family }]
    : await lookup(normalizedHost, { all: true, verbatim: true });

  if (
    addresses.length === 0 ||
    addresses.some((entry) =>
      blockedAddresses.check(entry.address, entry.family === 4 ? 'ipv4' : 'ipv6')
    )
  ) {
    throw new Error('URL host does not resolve exclusively to public IP addresses');
  }

  return addresses[0];
}

export interface FetchPublicUrlOptions {
  // Per-domain User-Agent override (e.g. a mobile UA for TikTok pages,
  // which serve a stripped page to unknown bots). Defaults to LinkMindBot.
  userAgent?: string;
  // Per-domain Accept override (e.g. application/json for the YouTube
  // Data API). Defaults to the HTML accept list below.
  accept?: string;
}

export async function fetchPublicUrl(
  input: string | URL,
  redirects = 0,
  options: FetchPublicUrlOptions = {}
): Promise<SafeResponse> {
  const url = input instanceof URL ? input : new URL(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    (url.port &&
      ((url.protocol === 'http:' && url.port !== '80') ||
        (url.protocol === 'https:' && url.port !== '443')))
  ) {
    throw new Error('Unsupported URL');
  }

  const address = await resolvePublicAddress(hostname);
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: address.address, family: address.family }]);
    } else {
      callback(null, address.address, address.family);
    }
  };
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;

  const response = await new Promise<SafeResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const req = request(
      url,
      {
        lookup: pinnedLookup,
        headers: {
          Accept: options.accept ?? 'text/html,application/xhtml+xml',
          'User-Agent': options.userAgent ?? 'LinkMindBot/1.0',
        },
        maxHeaderSize: 16_384,
        servername: isIP(hostname) ? undefined : hostname,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          res.resume();
          if (redirects >= MAX_REDIRECTS) {
            fail(new Error('Too many redirects'));
            return;
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, url);
          } catch (error) {
            fail(error instanceof Error ? error : new Error('Invalid redirect URL'));
            return;
          }
          void fetchPublicUrl(nextUrl, redirects + 1, options).then(
            (result) => {
              if (!settled) {
                settled = true;
                resolve(result);
              }
            },
            (error: Error) => fail(error)
          );
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            res.destroy(new Error('Response exceeds size limit'));
            return;
          }
          chunks.push(buffer);
        });
        res.on('end', () => {
          if (!settled) {
            settled = true;
            resolve({
              status,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          }
        });
        res.on('error', fail);
      }
    );

    req.setTimeout(8_000, () => req.destroy(new Error('Request timed out')));
    req.on('error', fail);
    req.end();
  });

  return response;
}
