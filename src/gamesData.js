export const games = [];

// Compute like percentage (0..100) from up/down; if no votes, show 100% by default (or 0 if both zero)
export function likePercentage(g) {
  const up = Math.max(0, Math.floor(g.up || 0));
  const down = Math.max(0, Math.floor(g.down || 0));
  const total = up + down;
  if (total === 0) return 100;
  return Math.round((up / total) * 100);
}

// Sorting helpers
export function getFilteredGames({ filter = 'popular', search = '' } = {}) {
  const q = (search || '').trim().toLowerCase();
  let list = games.slice();

  // Filter by query
  if (q.length > 0) {
    list = list.filter(g => g.name.toLowerCase().includes(q) || g.id.toLowerCase().includes(q));
  }

  // Apply sort filter
  switch (filter) {
    case 'most_upvoted':
      list.sort((a,b) => (b.up - a.up) || (b.visits - a.visits));
      break;
    case 'most_downvoted':
      list.sort((a,b) => (b.down - a.down) || (b.visits - a.visits));
      break;
    case 'popular':
    default:
      // Popular: visits primary, then upvotes
      list.sort((a,b) => (b.visits - a.visits) || (b.up - a.up));
      break;
  }
  return list;
}