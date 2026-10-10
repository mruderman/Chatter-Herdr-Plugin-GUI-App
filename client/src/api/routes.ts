// Every bridge path, built in one place. Only repo keys and handles are interpolated, each encoded
// as one path segment. Credentials never go in a URL: the token travels in `Authorization` and
// the stream cursor in `Last-Event-ID`.

const V1 = '/v1';

/** One path segment. `.` and `..` would be resolved away by the URL parser and reach another route. */
function segment(value: string, what: string): string {
  if (value === '' || value === '.' || value === '..') throw new TypeError(`not a usable ${what}: "${value}"`);
  return encodeURIComponent(value);
}

const repoPath = (key: string): string => `${V1}/repos/${segment(key, 'repo key')}`;
const memberPath = (handle: string): string => `${V1}/members/${segment(handle, 'handle')}`;

export const ROUTES = {
  health: '/healthz',
  me: `${V1}/me`,
  directory: `${V1}/directory`,
  repos: `${V1}/repos`,
  members: `${V1}/members`,
  audit: `${V1}/audit`,
  messages: (key: string): string => `${repoPath(key)}/messages`,
  stream: (key: string): string => `${repoPath(key)}/stream`,
  board: (key: string): string => `${repoPath(key)}/board`,
  read: (key: string): string => `${repoPath(key)}/read`,
  member: memberPath,
  memberToken: (handle: string): string => `${memberPath(handle)}/token`,
} as const;

/** Query parameter names the bridge reads. */
export const QUERY = {
  afterId: 'after_id',
  beforeId: 'before_id',
  limit: 'limit',
} as const;
