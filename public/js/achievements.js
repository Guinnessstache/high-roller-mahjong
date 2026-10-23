// Achievements, shared by the server (which detects them) and the game (which unlocks them).
// `id` is the Steamworks API name: enter these exactly in Steamworks → Stats & Achievements.
// `count` marks achievements tracked by a running total on the player's own PC.
export const ACHIEVEMENTS = [
  { id: 'FIRST_HAND', name: 'Pull Up a Chair', desc: 'Play your first hand.' },
  { id: 'FIRST_WIN', name: 'Sik Wu!', desc: 'Win your first hand.' },
  { id: 'SELF_DRAWN', name: 'Self-Made', desc: 'Win on a tile you drew yourself.' },
  { id: 'CONCEALED_WIN', name: 'Poker Face', desc: 'Win without claiming a single discard.' },
  { id: 'KONG_WIN', name: 'Flower on the Kong', desc: 'Win on the replacement tile after a kong.' },
  { id: 'ROB_KONG', name: 'Daylight Robbery', desc: 'Win by robbing someone’s kong.' },
  { id: 'ALL_PUNGS', name: 'Pung Crazy', desc: 'Win with All Pungs.' },
  { id: 'MIXED_SUIT', name: 'Half Measures', desc: 'Win with Mixed One Suit.' },
  { id: 'PURE_SUIT', name: 'One Suit Wonder', desc: 'Win with Pure One Suit.' },
  { id: 'DRAGONS', name: 'Dragon Tamer', desc: 'Win with Small or Great Three Dragons.' },
  { id: 'LIMIT_HAND', name: 'Over the Limit', desc: 'Win a limit hand.' },
  { id: 'THIRTEEN_ORPHANS', name: 'Thirteen Orphans', desc: 'Win with one of every terminal and honor.' },
  { id: 'HEAVENLY', name: 'Blessed by Heaven', desc: 'Win with the tiles you were dealt.' },
  { id: 'GAME_WIN', name: 'Table Champion', desc: 'Finish a full game with the most points.' },
  { id: 'HARD_WIN', name: 'Beat the Masters', desc: 'Finish first in a game with three Hard bots.' },
  { id: 'FRIENDLY_GAME', name: 'Friendly Game', desc: 'Play a hand with a friend at the table.' },
  { id: 'SAY_CHEESE', name: 'Say Cheese', desc: 'Sit at the table with your camera on.' },
  { id: 'HANDS_100', name: 'Regular', desc: 'Play 100 hands.', count: { stat: 'hands', target: 100 } },
  { id: 'WINS_50', name: 'Tile Shark', desc: 'Win 50 hands.', count: { stat: 'wins', target: 50 } },
  { id: 'HANDS_1000', name: 'Mahjong Master', desc: 'Play 1,000 hands.', count: { stat: 'hands', target: 1000 } },
];

export const ACHIEVEMENT_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));
