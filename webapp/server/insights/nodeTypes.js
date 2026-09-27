import { config } from '../config.js'
import { cached } from '../cache.js'
import { executeQuery } from '../powerbi/client.js'

/**
 * Production type per article, read from the recipe master itself.
 *
 * The obvious source is the local component copy, and it was the first one
 * tried - it carries `node_type` beside `article` already. It is the wrong
 * source, because the copy only holds a row where a recipe named the article
 * AND that recipe had a non-zero forecast inside the window the extract pulled.
 * Measured 27 Sep 2026 against the Sales Plan's article table: PAPER NAPKIN
 * PRINTED BBT (104900012) and MISHMASH PAPER NAPKIN (104900008) are both RAW in
 * 'RECIPE TABLE' - one recipe row and thirty-nine respectively - and both came
 * back blank from the copy, while PAPER NAPKIN WHITE beside them resolved. Two
 * articles of the same kind landing on opposite sides is the signature of a
 * coverage gap rather than a real difference.
 *
 * 'RECIPE TABLE' has no forecast condition on it at all, so it answers for
 * every article any recipe names. Articles no recipe names anywhere - TISSUE Z
 * FOLD, STICKER FOR BBT BAG and KETCHUP SACHET HEINZ among them, all confirmed
 * absent - still have no type, and that blank is the honest one.
 *
 * One dataset, not nine: the recipe table is a company-wide master and the same
 * rows are loaded into every model, which is why every page that reads it has
 * to scope it by brand some other way. Nothing here needs scoping, because the
 * question - what KIND of thing is this article - has the same answer whoever
 * is asking.
 */
export function articleNodeTypes() {
  const brand = config.brands[0]
  if (!brand?.datasetId) return Promise.resolve(new Map())

  return cached(`${brand.datasetId}:article-node-types`, async () => {
    const rows = await executeQuery(
      `EVALUATE
SUMMARIZECOLUMNS(
  'RECIPE TABLE'[Item No.],
  'RECIPE TABLE'[Node Type],
  "n", COUNTROWS('RECIPE TABLE')
)`,
      brand.datasetId,
      { bulk: true }
    ).catch((err) => {
      console.warn(`  [node-types] could not read the recipe master (${err.message})`)
      return null
    })
    if (!rows) return new Map()

    /*
     * An article can carry more than one type across recipes, so the type
     * backed by the most rows wins, ties broken alphabetically - two runs of
     * the same data must not disagree.
     */
    const best = new Map()
    for (const r of rows) {
      const article = String(r['Item No.'] ?? r['[Item No.]'] ?? '').trim()
      const type = String(r['Node Type'] ?? r['[Node Type]'] ?? '').trim()
      if (!article || !type) continue
      const n = Number(r.n ?? r['[n]']) || 0
      const held = best.get(article)
      if (!held || n > held.n || (n === held.n && type < held.type)) best.set(article, { type, n })
    }

    /*
     * Keyed both as written and with any leading zeros stripped.
     *
     * 'RECIPE TABLE'[Item No.] is an Integer in BBT's model and Text in the
     * others, so the same article arrives as 104900012 or "104900012"
     * depending on which model answered - and a text one may carry leading
     * zeros the integer cannot. Holding both forms means the lookup does not
     * depend on which model happened to be first in the list.
     */
    const out = new Map()
    for (const [article, { type }] of best) {
      out.set(article, type)
      const bare = article.replace(/^0+/, '')
      if (bare && !out.has(bare)) out.set(bare, type)
    }
    return out
  })
}
