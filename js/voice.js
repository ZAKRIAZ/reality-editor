// ============ Voice commands (Web Speech API) ============
// "make this underwater" · "turn this room into space" · "freeze this" · …

const KEYWORDS = [
  [['space', 'cosmic', 'galaxy', 'universe', 'stars'],        'cosmic'],
  [['cyber', 'neon', 'futuristic city', 'cyberpunk'],         'cyberpunk'],
  [['underwater', 'water world', 'ocean', 'sea', 'aquarium'], 'underwater'],
  [['lava', 'hell', 'volcano', 'fire', 'burn'],               'lava'],
  [['quantum', 'glitch', 'unstable'],                         'quantum'],
  [['crystal', 'diamond', 'gem'],                             'crystal'],
  [['frozen', 'ice', 'snow', 'freeze this object', 'cold'],   'frozenWorld'],
  [['dream', 'surreal'],                                      'dream'],
  [['pixel', 'voxel', '8-bit', '8 bit', 'minecraft'],         'pixel'],
  [['void', 'darkness', 'dark dimension'],                    'void'],
  [['black hole', 'blackhole', 'increase gravity', 'stronger gravity'], 'blackhole'],
  [['zero gravity', 'no gravity', 'levitate', 'float', 'anti gravity'], 'zerog'],
  [['heavy gravity', 'crush', 'gravity waves'],               'crush'],
  [['freeze time', 'stop time', 'freeze'],                    'timefreeze'],
  [['slow motion', 'slow time', 'slow down'],                 'slowmo'],
  [['reverse', 'rewind', 'backwards'],                        'reverse'],
  [['echo', 'ghost', 'replay', 'timelines'],                  'echo'],
  [['gold', 'golden'],                                        'gold'],
  [['glass', 'transparent'],                                  'glass'],
  [['plasma', 'energy', 'electricity', 'lightning'],          'plasma'],
  [['mirror'],                                                'mirror'],
  [['twist', 'warp', 'bend'],                                 'twist'],
  [['portal', 'tunnel', 'wormhole', 'infinite'],              'tunnel'],
];

const ACTIONS = [
  [['clear', 'reset', 'undo', 'remove', 'back to normal', 'restore'], 'clear'],
  [['duplicate', 'copy', 'clone'],                                    'duplicate'],
  [['lock'],                                                          'lock'],
  [['next'],                                                          'cycle'],
];

// `includes()` also matches inside longer words: 'lock' fires on "block" and
// "clock", 'ice' on "nice". Since ACTIONS is checked first and returns early,
// "turn this into a block of ice" toggled lock instead of applying the frozen
// effect. Match whole words and phrases only.
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasPhrase = (text, phrase) => new RegExp(`\\b${escapeRe(phrase)}\\b`).test(text);

export function startVoice({ onEffect, onAction, onStatus }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { onStatus('VOICE: N/A'); return null; }

  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = false;
  rec.lang = 'en-US';
  let alive = true;

  rec.onresult = e => {
    const text = e.results[e.results.length - 1][0].transcript.toLowerCase();
    onStatus('VOICE: "' + text.trim().slice(0, 32) + '"');
    for (const [words, action] of ACTIONS)
      if (words.some(w => hasPhrase(text, w))) { onAction(action); return; }
    // longest keyword match wins ("freeze time" beats "freeze")
    let best = null, bestLen = 0;
    for (const [words, effect] of KEYWORDS)
      for (const w of words)
        if (hasPhrase(text, w) && w.length > bestLen) { best = effect; bestLen = w.length; }
    if (best) onEffect(best);
  };
  rec.onerror = e => { if (e.error === 'not-allowed') { alive = false; onStatus('VOICE: DENIED'); } };
  rec.onend = () => { if (alive) { try { rec.start(); } catch (_) {} } };

  try { rec.start(); onStatus('VOICE: LISTENING'); }
  catch (_) { onStatus('VOICE: OFF'); return null; }
  return () => { alive = false; rec.stop(); };
}
