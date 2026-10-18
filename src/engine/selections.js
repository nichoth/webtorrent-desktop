// Which file selection changes reach webtorrent.
//
// The UI sends the whole selection list on every checkbox toggle. In
// webtorrent 1.9.7 `file.select()` pushes a new entry onto the
// torrent's selection list every time, and `file.deselect()` removes
// only one matching entry. So re-applying the whole list grows the list
// the piece picker walks on every toggle, and a file selected twice
// then deselected once keeps downloading.
//
// The engine keeps the selections it last applied per torrent and
// sends webtorrent only the difference. `applied` is undefined the
// first time, which also means webtorrent's default whole-torrent
// selection is still in place and has to go before the per-file ones
// are added.

/**
 * @param {boolean[]|undefined} applied  the selections last applied, if
 *   any
 * @param {boolean[]} requested  the selections wanted now
 * @returns {{ replaceDefault: boolean, select: number[],
 *   deselect: number[] }}  the file indexes to change
 */
export function diffSelections (applied, requested) {
  const select = []
  const deselect = []
  requested.forEach((wanted, i) => {
    if (applied && Boolean(applied[i]) === Boolean(wanted)) return
    if (wanted) select.push(i)
    else deselect.push(i)
  })
  return { replaceDefault: !applied, select, deselect }
}
