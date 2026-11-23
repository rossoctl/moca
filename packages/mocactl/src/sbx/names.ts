/**
 * Default sandbox names: `adjective-surname`, as Docker names containers, with a hyphen since the
 * control plane takes only `^[a-z0-9][a-z0-9-]{0,62}$`. The surnames are notable scientists and
 * engineers. About 100 x 200 pairs: a clash among one user's few live sandboxes is rare, and the
 * create retries with another pair when one happens (createWaitingForActivation).
 */

// prettier-ignore
const ADJECTIVES = [
  'admiring', 'adoring', 'agile', 'amazing', 'awesome', 'blissful', 'bold', 'brave', 'bright',
  'busy', 'calm', 'careful', 'charming', 'cheerful', 'clever', 'cool', 'compassionate', 'confident',
  'cranky', 'curious', 'dazzling', 'determined', 'diligent', 'eager', 'ecstatic', 'elastic',
  'elated', 'elegant', 'eloquent', 'epic', 'exciting', 'fervent', 'festive', 'focused', 'friendly',
  'frosty', 'funny', 'gallant', 'gentle', 'gifted', 'goofy', 'gracious', 'great', 'happy',
  'hardcore', 'heuristic', 'hopeful', 'hungry', 'infallible', 'inspiring', 'intelligent',
  'interesting', 'jolly', 'jovial', 'keen', 'kind', 'laughing', 'lively', 'loving', 'lucid',
  'magical', 'merry', 'modest', 'musing', 'mystifying', 'naughty', 'nervous', 'nice', 'nifty',
  'nimble', 'nostalgic', 'objective', 'optimistic', 'patient', 'peaceful', 'pensive', 'placid',
  'playful', 'pleasant', 'practical', 'priceless', 'quiet', 'quirky', 'radiant', 'relaxed',
  'reverent', 'romantic', 'serene', 'sharp', 'silly', 'sleepy', 'stoic', 'steady', 'sunny',
  'sweet', 'tender', 'thirsty', 'tranquil', 'trusting', 'upbeat', 'vibrant', 'vigilant',
  'vigorous', 'wizardly', 'wonderful', 'youthful', 'zealous', 'zen',
] as const;

// prettier-ignore
const SURNAMES = [
  'agnesi', 'albattani', 'allen', 'almeida', 'antonelli', 'archimedes', 'ardinghelli', 'aryabhata',
  'austin', 'babbage', 'banach', 'banzai', 'bardeen', 'bartik', 'bassi', 'beaver', 'bell', 'benz',
  'bhabha', 'bhaskara', 'black', 'blackburn', 'blackwell', 'bohr', 'booth', 'borg', 'bose',
  'bouman', 'boyd', 'brahmagupta', 'brattain', 'brown', 'buck', 'burnell', 'cannon', 'carson',
  'cartwright', 'carver', 'cerf', 'chandrasekhar', 'chaplygin', 'chatelet', 'chatterjee',
  'chebyshev', 'clarke', 'cohen', 'colden', 'cori', 'cray', 'curie', 'curran', 'darwin',
  'davinci', 'dewdney', 'dhawan', 'diffie', 'dijkstra', 'dirac', 'driscoll', 'dubinsky', 'easley',
  'edison', 'einstein', 'elbakyan', 'elgamal', 'elion', 'ellis', 'engelbart', 'euclid', 'euler',
  'faraday', 'feistel', 'fermat', 'fermi', 'feynman', 'franklin', 'gagarin', 'galileo', 'galois',
  'ganguly', 'gates', 'gauss', 'germain', 'goldberg', 'goldstine', 'goldwasser', 'golick',
  'goodall', 'gould', 'greider', 'grothendieck', 'haibt', 'hamilton', 'haslett', 'hawking',
  'heisenberg', 'hellman', 'hermann', 'herschel', 'hertz', 'heyrovsky', 'hodgkin', 'hofstadter',
  'hoover', 'hopper', 'hugle', 'hypatia', 'ishizaka', 'jackson', 'jang', 'jemison', 'jennings',
  'jepsen', 'johnson', 'joliot', 'jones', 'kalam', 'kapitsa', 'kare', 'keldysh', 'keller',
  'kepler', 'khayyam', 'khorana', 'kilby', 'kirch', 'knuth', 'kowalevski', 'lalande', 'lamarr',
  'lamport', 'leakey', 'leavitt', 'lederberg', 'lehmann', 'lewin', 'lichterman', 'liskov',
  'lovelace', 'lumiere', 'mahavira', 'margulis', 'matsumoto', 'maxwell', 'mayer', 'mccarthy',
  'mcclintock', 'mclaren', 'mclean', 'mcnulty', 'meitner', 'mendel', 'mendeleev', 'meninsky',
  'merkle', 'mestorf', 'mirzakhani', 'montalcini', 'moore', 'morse', 'moser', 'murdock', 'napier',
  'nash', 'neumann', 'newton', 'nightingale', 'nobel', 'noether', 'northcutt', 'noyce', 'panini',
  'pare', 'pascal', 'pasteur', 'payne', 'perlman', 'pike', 'poincare', 'poitras', 'proskuriakova',
  'ptolemy', 'raman', 'ramanujan', 'rhodes', 'ride', 'ritchie', 'robinson', 'roentgen',
  'rosalind', 'rubin', 'saha', 'sammet', 'sanderson', 'satoshi', 'shamir', 'shannon', 'shaw',
  'shirley', 'shockley', 'shtern', 'sinoussi', 'snyder', 'solomon', 'spence', 'stonebraker',
  'sutherland', 'swanson', 'swartz', 'swirles', 'taussig', 'tesla', 'tharp', 'thompson',
  'torvalds', 'tu', 'turing', 'varahamihira', 'vaughan', 'villani', 'visvesvaraya', 'volhard',
  'wescoff', 'wilbur', 'wiles', 'williams', 'williamson', 'wilson', 'wing', 'wozniak', 'wright',
  'wu', 'yalow', 'yonath', 'zhukovsky',
] as const;

/** One of `list`, picked by `random` (0 to 1, as Math.random). */
const pick = <T>(list: readonly T[], random: () => number): T =>
  list[Math.min(list.length - 1, Math.floor(random() * list.length))]!;

/** A default sandbox name, `adjective-surname` (`eager-hopper`). */
export function sandboxName(random: () => number = Math.random): string {
  return `${pick(ADJECTIVES, random)}-${pick(SURNAMES, random)}`;
}
