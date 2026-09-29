/* Pure, DOM-free password rules shared by the server (server/auth/crypto.js) and the browser (auth-logic.js), so the
   strength meter and the server always agree. Nothing here logs or stores a password. */

export const MIN_LEN = 10;
export const MAX_LEN = 200;

// Very common passwords / stems (lower-case). A password whose letters (digits and symbols stripped, common leetspeak
// folded) equal one of these, or are one plus <= 2 letters, is rejected: "Password1!", "P@ssw0rd2024", "Dragon123"...
const STEMS = `password passwort passw0rd pass pass1 passwd letmein welcome admin administrator root login master
qwerty qwertyuiop qwertz azerty asdfgh asdfghjkl zxcvbn zxcvbnm qazwsx qazwsxedc zaqwsx zaq wsxedc 1qaz2wsx
iloveyou ilovegod ilovelove loveyou lovely lover love princess sunshine shadow superman batman spiderman ironman
football baseball basketball soccer hockey tennis golf cricket rugby boxing wrestling jordan lakers yankees cowboys
dragon monkey tiger lion eagle falcon phoenix wolf panda kitty kitten puppy buster charlie daniel andrew michael
jessica jennifer ashley nicole amanda melissa hannah samantha stephanie thomas jordan joshua matthew chris
george harley ranger hunter killer ninja pirate soldier warrior wizard knight master mustang ferrari porsche
mercedes toyota honda ford chevy corvette camaro harley yamaha suzuki nissan
trustno1 changeme changemenow default guest user test tester testing temp temporary demo sample example
secret secure security private access system computer internet network server database admin1 abc abcdef abcdefgh
abcdefghij abcd alphabet hello hello1 helloworld world google facebook twitter youtube gmail yahoo hotmail
microsoft apple windows linux ubuntu android iphone samsung nokia sony
trading tradingbot trader stocks stock market money dollar bitcoin crypto invest wallstreet
starwars startrek pokemon naruto mario zelda minecraft fortnite matrix avatar gandalf hobbit
summer winter spring autumn fall january february march april june july august september october november december
monday tuesday wednesday thursday friday saturday sunday
pepper ginger cookie cheese chocolate coffee banana orange cherry apple peanut butter pizza burger
maggie molly lucky sophie bailey buddy jasper rocky max sam tom ben joe
freedom liberty america usa canada england london paris tokyo texas california florida newyork
whatever nothing anything something everything forever always never mypassword mypass myself yourself
computer laptop keyboard mouse monitor printer server
starlight moonlight rainbow butterfly flower flowers angel angels heaven baby babygirl babyboy honey sweety
sweetheart darling cutie beauty pretty sexy hottie cool awesome amazing super mega ultra power
blink182 metallica nirvana eminem beatles slipknot linkinpark
america1 secret1 access14 aaaaaa aaaaaaa zzzzzz qqqqqq ffffff
fuckyou fuckyou1 fuckoff asshole bitch shit`.split(/\s+/);

// Exact common passwords worth blocking as typed (letters+digits, lower-case), including keyboard/number patterns.
const EXACT = `1234567890 12345678901 123456789012 1234567890123 12345678910 0123456789 0987654321 9876543210 0123456789012
1111111111 2222222222 0000000000 1212121212 1231231231 1122334455 112233445566 1234512345 123456123456 123123123123
1q2w3e4r5t 1q2w3e4r5t6y q1w2e3r4t5 q1w2e3r4t5y6 1qaz2wsx3edc 1qazxsw2 zaq12wsx zaq1zaq1 zaq12wsxcde3 qazwsxedcrfv
qwertyuiop qwertyuiop1 qwertyuiop123 qwerty1234 qwerty12345 qwerty123456 qwerty1234567 qwertyuiopasdfghjkl asdfghjkl1 asdfghjkl123
zxcvbnm123 zxcvbnm1234 asdfasdfasdf asdf1234 asdf12345 asdf123456 qweasdzxc qweasdzxc123 qwe123qwe qwe123456 qweqweqwe
password12 password123 password1234 password12345 password123456 password1! password1 passw0rd1 passw0rd12 passw0rd123 p@ssw0rd p@ssword p@ssw0rd1 p@ssword1 p@ssword123
pass123456 pass1234567 mypassword1 mypassword123 letmein123 letmein1234 letmein12345 welcome123 welcome1234 welcome12345
admin12345 admin123456 admin1234567 administrator1 administrator123 changeme123 changeme1234 changemenow1
iloveyou12 iloveyou123 iloveyou1234 iloveyou2 iloveyou69 iloveyou1! trustno1234 monkey12345 monkey123456 dragon12345 dragon123456
football123 football1234 baseball123 basketball1 superman123 batman12345 princess123 princess1234 sunshine123 sunshine1234
starwars123 starwars1234 michael123 jennifer123 jessica123 charlie123 thomas1234 daniel1234 andrew1234
abc1234567 abc123456789 abcd123456 abcd1234567 abcdefghij abcdefghijk abcdefghijklm abcdefg123 abcdef1234 abcabcabcabc
tradingbot tradingbot1 tradingbot12 tradingbot123 trading123 trading1234 trading12345 stockmarket1 bitcoin123
hello12345 hello123456 helloworld1 helloworld123 test123456 test1234567 testing1234 testtest12 guest12345
qwertyui123 iloveyou1234567 lovelove123 sweetheart1 babygirl123 sunshine12 shadow1234 shadow12345 master1234 master12345
computer123 computer1234 internet123 secret1234 secret12345 secret123456 private123 freedom123 whatever123
0p9o8i7u6y 1qa2ws3ed 1qa2ws3ed4rf 2wsx3edc4rfv 1z2x3c4v5b zaq1xsw2cde3 xsw21qaz cde3vfr4 q2w3e4r5t6 !qaz2wsx #edc4rfv
a1b2c3d4e5 a1b2c3d4e5f6 abc123abc123 aa123456789 aaaa111111 aaaaaa1111 aaaaaaaaaa 1111111111a 111111aaaaa 11111aaaaa
password11 password22 password99 password01 password00 password2020 password2021 password2022 password2023 password2024 password2025 password2026
passw0rd2024 iloveyou2024 welcome2024 summer2024 winter2024 spring2024 autumn2024 summer2025 winter2025 summer2026 winter2026
football2024 baseball2024 letmein2024 changeme2024 admin2024 admin2025 admin2026`.split(/\s+/);

const STEM_SET = new Set(STEMS);
const EXACT_SET = new Set(EXACT.map((s) => s.toLowerCase()));
/** Number of blocklist entries embedded (for tests / docs). */
export const BLOCKLIST_SIZE = STEM_SET.size + EXACT_SET.size;

const ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** +1 / -1 when b directly follows / precedes a in the alphabet, the digits or a keyboard row; else 0. */
function step(a, b) {
  const d = b.charCodeAt(0) - a.charCodeAt(0);
  if (Math.abs(d) === 1 && /[a-z]/.test(a) === /[a-z]/.test(b) && /[a-z0-9]/.test(a) && /[a-z0-9]/.test(b)) return d;
  if (a === '9' && b === '0') return 1;
  if (a === '0' && b === '9') return -1;
  for (const r of ROWS) {
    const i = r.indexOf(a);
    const j = r.indexOf(b);
    if (i >= 0 && j >= 0 && Math.abs(i - j) === 1) return j - i;
  }
  return 0;
}

/** Number of characters inside runs (>= 4 long) of sequential letters/digits or keyboard walks, in one direction. */
function patternCoverage(lower) {
  const covered = new Array(lower.length).fill(false);
  let i = 0;
  while (i < lower.length - 1) {
    let j = i;
    let dir = 0;
    while (j < lower.length - 1) {
      const s = step(lower[j], lower[j + 1]);
      if (!s || (dir && s !== dir)) break;
      dir = s;
      j++;
    }
    if (j - i + 1 >= 4) for (let k = i; k <= j; k++) covered[k] = true;
    i = Math.max(j, i + 1);
  }
  return covered.filter(Boolean).length;
}

const FOLD = { '@': 'a', 4: 'a', 0: 'o', 3: 'e', $: 's', 5: 's', 7: 't', 1: 'l', '!': 'i' };

function stemHit(lower) {
  const fold = (map) => [...lower].map((c) => map[c] ?? c).join('').replace(/[^a-z]/g, '');
  const forms = new Set([lower.replace(/[^a-z]/g, ''), fold(FOLD), fold({ ...FOLD, 1: 'i' })]);
  for (const f of forms) {
    if (f.length < 3) continue;
    if (STEM_SET.has(f)) return true;
    for (let cut = 1; cut <= 2; cut++) {
      if (f.length > cut && f.length - cut >= 5 && (STEM_SET.has(f.slice(0, -cut)) || STEM_SET.has(f.slice(cut)))) return true;
    }
  }
  return false;
}

/** Repeating block: "abcdabcdab", "xyxyxyxyxy", "passpasspass". */
function isRepeating(p) {
  for (let k = 1; k <= p.length / 2; k++) {
    let ok = true;
    for (let i = k; i < p.length; i++) if (p[i] !== p[i - k]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

/**
 * Returns an error message, or null when the password passes. `email` is optional: when given, the password may not
 * contain its local part (before the @) nor equal the address.
 */
export function passwordRuleProblem(password, email = '') {
  if (typeof password !== 'string') return 'password is required';
  if (password.length < MIN_LEN) return `password must be at least ${MIN_LEN} characters`;
  if (password.length > MAX_LEN) return `password is too long (max ${MAX_LEN} characters)`;
  const lower = password.toLowerCase();
  const simple = 'that password is too common or too simple; choose a longer, less predictable one';
  if (new Set(lower).size < 4) return simple;
  if (isRepeating(lower)) return 'password must not be a repeating pattern';
  if (patternCoverage(lower) >= lower.length - 3) return 'password must not be a sequence or keyboard pattern (like 12345 or qwerty)';
  if (EXACT_SET.has(lower) || EXACT_SET.has(lower.replace(/[^a-z0-9]/g, '')) || stemHit(lower)) return simple;
  const mail = String(email || '').trim().toLowerCase();
  if (mail) {
    const local = mail.split('@')[0];
    if (lower === mail || (local.length >= 3 && lower.replace(/[^a-z0-9]/g, '').includes(local.replace(/[^a-z0-9]/g, '')) && local.replace(/[^a-z0-9]/g, '').length >= 3)) {
      return 'password must not contain your email address';
    }
  }
  return null;
}
