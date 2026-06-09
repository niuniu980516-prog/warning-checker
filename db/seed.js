/**
 * Seed script: imports all check rules from 廣告文宣檢查表 and 警語大全
 * Run: node db/seed.js
 * Idempotent: safe to run multiple times
 */
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { migrate } = require('./migrate');

const db = migrate();

// ─── helpers ────────────────────────────────────────────────────────────────

function upsertCheckItem(item) {
  db.prepare(`
    INSERT INTO check_items (id, category, description, check_type, group_name, parameters, is_active, sort_order)
    VALUES (@id, @category, @description, @check_type, @group_name, @parameters, @is_active, @sort_order)
    ON CONFLICT(id) DO UPDATE SET
      category=excluded.category, description=excluded.description,
      check_type=excluded.check_type, group_name=excluded.group_name,
      parameters=excluded.parameters,
      sort_order=excluded.sort_order
  `).run({
    id: item.id, category: item.category, description: item.description,
    check_type: item.check_type, group_name: item.group_name, sort_order: item.sort_order,
    parameters: JSON.stringify(item.parameters || {}),
    is_active: 1,
  });
}

function upsertForbiddenTerm(item) {
  db.prepare(`
    INSERT INTO forbidden_terms (id, category, term, semantic_group, exception_rule, check_item_id, is_active)
    VALUES (@id, @category, @term, @semantic_group, @exception_rule, @check_item_id, 1)
    ON CONFLICT(id) DO UPDATE SET
      category=excluded.category, term=excluded.term,
      semantic_group=excluded.semantic_group, exception_rule=excluded.exception_rule
  `).run({
    exception_rule: null,
    check_item_id: null,
    ...item,
    semantic_group: JSON.stringify(item.semantic_group || []),
  });
}

function upsertWarningText(item) {
  db.prepare(`
    INSERT INTO warning_texts (id, name, trigger_keywords, trigger_type, warning_text, placement_rule, format_requirements, preconditions, is_active)
    VALUES (@id, @name, @trigger_keywords, @trigger_type, @warning_text, @placement_rule, @format_requirements, @preconditions, 1)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, trigger_keywords=excluded.trigger_keywords,
      trigger_type=excluded.trigger_type, warning_text=excluded.warning_text,
      placement_rule=excluded.placement_rule, format_requirements=excluded.format_requirements,
      preconditions=excluded.preconditions
  `).run({
    ...item,
    trigger_keywords: JSON.stringify(item.trigger_keywords || []),
    format_requirements: JSON.stringify(item.format_requirements || { bold: true }),
    preconditions: JSON.stringify(item.preconditions || []),
  });
}

// fund_warnings now only holds the fund identity (name/aliases/category); each
// warning text to check is a separate fund_warning_items row (1 fund -> N items),
// so a fund can require checking for any number of distinct warnings. Seed data
// still expresses funds via the legacy annotation_text/comprehensive_warning shape
// for readability — convert that into items here (delete+reinsert keeps this idempotent).
function upsertFundWarning(item) {
  db.prepare(`
    INSERT INTO fund_warnings (id, fund_name, aliases, warning_category, is_active)
    VALUES (@id, @fund_name, @aliases, @warning_category, 1)
    ON CONFLICT(id) DO UPDATE SET
      fund_name=excluded.fund_name, aliases=excluded.aliases,
      warning_category=excluded.warning_category
  `).run({
    id: item.id,
    fund_name: item.fund_name,
    warning_category: item.warning_category,
    aliases: JSON.stringify(item.aliases || []),
  });

  db.prepare('DELETE FROM fund_warning_items WHERE fund_id = ?').run(item.id);
  const insertItem = db.prepare(`
    INSERT INTO fund_warning_items (id, fund_id, name, warning_text, require_immediately_after, format_requirements, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let order = 1;
  if (item.annotation_text) {
    const fmt = item.annotation_format || {};
    insertItem.run(
      uuidv4(), item.id, '加注文字', item.annotation_text,
      fmt.immediately_after ? 1 : 0,
      JSON.stringify({ bold: !!fmt.bold, distinctive_color: !!fmt.distinctive_color, same_size: !!fmt.same_size }),
      order++
    );
  }
  if (item.comprehensive_warning) {
    insertItem.run(uuidv4(), item.id, '綜合警語', item.comprehensive_warning, 0, '{}', order++);
  }
}

// ─── 1. Admin user ────────────────────────────────────────────────────────────

const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!existingAdmin) {
  db.prepare(`
    INSERT INTO users (id, username, password_hash, role)
    VALUES (?, ?, ?, 'admin')
  `).run(uuidv4(), 'admin', bcrypt.hashSync('Admin1234!', 10));
  console.log('Created default admin user (admin / Admin1234!)');
}

// ─── 2. Check items from 廣告文宣檢查表 ──────────────────────────────────────

const checkItems = [
  // ── 基金績效及業績數字之表達 ─────────────────────────────────────────────
  {
    id: 'perf_min_age',
    category: '基金績效及業績數字之表達',
    description: '基金需成立滿6個月以上者，始能刊登全部績效或年度績效',
    check_type: 'ai',
    group_name: 'ai_performance',
    sort_order: 10,
  },
  {
    id: 'perf_date_limit',
    category: '基金績效及業績數字之表達',
    description: '基金績效日期僅能揭露至最近月月底',
    check_type: 'ai',
    group_name: 'ai_performance',
    sort_order: 11,
  },
  {
    id: 'perf_period_under3y',
    category: '基金績效及業績數字之表達',
    description: '成立未滿三年者：應揭示近3個月、6個月、1年、2年及自成立以來報酬率，資料應計算至月底最近日期',
    check_type: 'ai',
    group_name: 'ai_performance',
    sort_order: 12,
  },
  {
    id: 'perf_period_over3y',
    category: '基金績效及業績數字之表達',
    description: '成立滿三年者：應揭示近1年、2年、3年報酬率，資料應計算至月底最近日期',
    check_type: 'ai',
    group_name: 'ai_performance',
    sort_order: 13,
  },
  {
    id: 'perf_annual_over10y',
    category: '基金績效及業績數字之表達',
    description: '以年度績效為廣告：成立滿10年以上者應揭示最近十年度各年度績效；未滿10年者應揭示自成立以來各年度績效',
    check_type: 'ai',
    group_name: 'ai_performance',
    sort_order: 14,
  },
  {
    id: 'perf_dca',
    category: '基金績效及業績數字之表達',
    description: '定時定額基金績效：基金須成立滿一年；須載明計算期間及扣款日期；成立未滿三年揭露1年/2年/自成立以來績效；成立滿三年至少揭露三年績效；不可揭露一年以下期間投資績效',
    check_type: 'ai',
    group_name: 'ai_performance',
    sort_order: 15,
  },
  {
    id: 'perf_no_specific_period_title',
    category: '基金績效及業績數字之表達',
    description: '不得截取特定期間之基金績效及ETF追蹤指數績效為廣告標題或訴求',
    check_type: 'ai',
    group_name: 'ai_performance',
    sort_order: 16,
  },
  {
    id: 'perf_no_highlight',
    category: '基金績效及業績數字之表達',
    description: '績效及ETF追蹤指數績效數值或排名不得以特別標識、劃線、不同顏色、放大、粗體等方式加以強調',
    check_type: 'ai',
    group_name: 'ai_performance',
    sort_order: 17,
  },
  {
    id: 'perf_only_in_table',
    category: '基金績效及業績數字之表達',
    description: '基金績效「數值」僅能在基金績效表格中呈現，不得在廣告文宣中出現',
    check_type: 'ai',
    group_name: 'ai_performance',
    sort_order: 18,
  },
  {
    id: 'perf_benchmark_consistency',
    category: '基金績效及業績數字之表達',
    description: '基金績效與Benchmark比較時，比較基期、基礎及計算幣別應一致，並應加註說明；Benchmark應為公開說明書所揭露者',
    check_type: 'ai',
    group_name: 'ai_performance',
    sort_order: 19,
  },
  {
    id: 'perf_ranking_top_half',
    category: '基金績效及業績數字之表達',
    description: '基金各期間績效排名皆為同類型基金前1/2者，才得以文字形容該基金績效，且須一併揭示全部績效及同類型基金績效平均數或指標績效',
    check_type: 'ai',
    group_name: 'ai_performance',
    sort_order: 20,
  },
  {
    id: 'perf_source_required',
    category: '基金績效及業績數字之表達',
    description: '任何基金績效及業績數字均需註明使用資料來源及日期',
    check_type: 'auto_keyword',
    group_name: 'auto',
    parameters: {
      type: 'conditional_required',
      trigger_keywords: ['績效', '報酬率', '排名', '規模', '淨值'],
      required_keywords: ['資料來源', 'Lipper', '晨星', '嘉實', '彭博', 'Bloomberg', '公會', '嘉實XQ'],
      violation: '刊載績效/報酬率/排名等資訊時，未標注資料來源及日期',
    },
    sort_order: 21,
  },
  {
    id: 'perf_source_approved',
    category: '基金績效及業績數字之表達',
    description: '基金績效僅能採用「公會」、「Lipper」、「晨星(Morningstar)」、「嘉實(FundDJ)」或「彭博(Bloomberg)」之資料',
    check_type: 'ai',
    group_name: 'ai_performance',
    sort_order: 22,
  },
  {
    id: 'perf_scale_timing',
    category: '基金績效及業績數字之表達',
    description: '基金規模需於次月十個營業日後，才可對外廣告本月底之規模',
    check_type: 'ai',
    group_name: 'ai_performance',
    sort_order: 23,
  },
  {
    id: 'perf_top10_timing',
    category: '基金績效及業績數字之表達',
    description: '基金前十大持股僅能公布至上月月底資訊',
    check_type: 'ai',
    group_name: 'ai_performance',
    sort_order: 24,
  },
  {
    id: 'perf_sector_timing',
    category: '基金績效及業績數字之表達',
    description: '基金持有類股比率需於每週二後，才可對外廣告上週五之持有類股比率',
    check_type: 'ai',
    group_name: 'ai_performance',
    sort_order: 25,
  },
  {
    id: 'perf_linechart_rule',
    category: '基金績效及業績數字之表達',
    description: '以線圖呈現基金績效者，應揭示自成立以來績效（成立滿3年以上基金，得自行決定揭示自成立以來或最近3年績效）',
    check_type: 'ai',
    group_name: 'ai_performance',
    sort_order: 26,
  },
  {
    id: 'perf_dividend_rate_disclosure',
    category: '基金績效及業績數字之表達',
    description: '以基金配息率為廣告時，應同時揭露各期間之報酬率（含息）或報酬率（不含息），並說明報酬率之計算方式',
    check_type: 'ai',
    group_name: 'ai_dividend',
    sort_order: 27,
  },

  // ── 投資策略及標的 ───────────────────────────────────────────────────────
  {
    id: 'strategy_consistency',
    category: '投資策略及標的',
    description: '投資策略或投資標的應與信託契約或發行計畫內容一致',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 30,
  },

  // ── 避免不當方式勸誘 ─────────────────────────────────────────────────────
  {
    id: 'no_gift_incentive',
    category: '避免不當方式勸誘',
    description: '不可提供贈品、招待券或將收入作為公益捐贈之方式勸誘他人開戶或購買基金',
    check_type: 'auto_keyword',
    group_name: 'auto',
    parameters: {
      type: 'forbidden_keywords',
      keywords: ['贈品', '招待券', '公益捐贈', '刷卡禮', '好禮', '好康'],
      violation: '疑似以贈品/招待券方式勸誘投資',
    },
    sort_order: 40,
  },

  // ── 贈品規定 ──────────────────────────────────────────────────────────────
  {
    id: 'gift_rules',
    category: '贈品規定',
    description: '在不與基金申購結合之前提下，提供贈品是否依規範辦理；並且按月申報',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 50,
  },

  // ── 警語之標示 ────────────────────────────────────────────────────────────
  {
    id: 'warn_font_bold',
    category: '警語之標示',
    description: '警語字體不可為該份文宣最小字體，並應以粗體標示',
    check_type: 'auto_format',
    group_name: 'auto',
    parameters: {
      type: 'warning_font_format',
      require_bold: true,
      require_not_smallest: true,
    },
    sort_order: 60,
  },
  {
    id: 'warn_fund_annotation',
    category: '警語之標示',
    description: '特定基金名稱後方（含圖表）每次出現均須緊接加注對應風險說明文字（粗體或顯著顏色及相同大小字體）',
    check_type: 'auto_format',
    group_name: 'auto',
    parameters: {
      type: 'fund_name_annotation',
      require_immediately_after: true,
      require_bold_or_color: true,
      require_same_size: true,
    },
    sort_order: 61,
  },
  {
    id: 'warn_individual_stock',
    category: '警語之標示',
    description: '文章提及個股時（含具體股票名稱/代號），是否加注「個股與相關數據資料僅供說明之用，不代表投資決策之建議。」（粗體）（當頁文宣）',
    check_type: 'ai',
    group_name: 'ai_warnings',
    parameters: {
      placement: 'same_page',
      required_warning_id: 'wt_individual_stock',
    },
    sort_order: 62,
  },
  {
    id: 'warn_example_figure',
    category: '警語之標示',
    description: '內文數值或圖表明顯聯想到基金績效之保證，是否加注「以上資料為舉例說明，不代表未來實際績效。」（粗體）（當頁文宣）',
    check_type: 'ai',
    group_name: 'ai_warnings',
    parameters: {
      placement: 'same_page',
      required_warning_id: 'wt_example_figure',
    },
    sort_order: 63,
  },
  {
    id: 'warn_dca_method',
    category: '警語之標示',
    description: '投資方法論（含好利high定時定額及複合投資法等）是否加注「投資人因不同時間進場，將有不同之投資績效，過去之績效亦不代表未來績效之保證。」（粗體）（當頁文宣）',
    check_type: 'ai',
    group_name: 'ai_warnings',
    parameters: {
      placement: 'same_page',
      required_warning_id: 'wt_dca',
    },
    sort_order: 64,
  },
  {
    id: 'warn_influencer',
    category: '警語之標示',
    description: '網紅所發表之資訊內容，應揭示或說明「非分析意見及推介建議」之警語',
    check_type: 'ai',
    group_name: 'ai_warnings',
    sort_order: 65,
  },
  {
    id: 'warn_dividend_ad',
    category: '警語之標示',
    description: '以基金配息率或配息金額為廣告者，是否加注「基金配息不代表基金實際報酬，且過去配息不代表未來配息；基金淨值可能因市場因素而上下波動。」（粗體）（文宣最後）',
    check_type: 'ai',
    group_name: 'ai_warnings',
    parameters: {
      placement: 'document_end',
      required_warning_id: 'wt_dividend',
    },
    sort_order: 66,
  },
  {
    id: 'warn_limited_space',
    category: '警語之標示',
    description: '透過手機簡訊、電視、電影或版面受限之圖像式廣告(Banner/Button/Icon等)為廣告，應揭示基本警語並以清楚易辨識之連結直接連結至完整警語頁',
    check_type: 'ai',
    group_name: 'ai_warnings',
    sort_order: 67,
  },
  {
    id: 'warn_paid_placement',
    category: '警語之標示',
    description: '於第三方刊物/平台/媒體進行付費置入性行銷時，應於廣告內容明顯揭露「復華投信廣告文宣」、「復華投信行銷資訊」或「復華投信贊助播出」',
    check_type: 'ai',
    group_name: 'ai_warnings',
    sort_order: 68,
  },
  {
    id: 'warn_economic_forecast',
    category: '警語之標示',
    description: '內文提及投資範圍或市場之經濟走勢預測時，是否加注「本文提及之經濟走勢預測不必然代表本基金之績效，本基金投資風險請詳閱基金公開說明書」（粗體）（文宣最後）',
    check_type: 'ai',
    group_name: 'ai_warnings',
    parameters: {
      placement: 'document_end',
      required_warning_id: 'wt_economic_forecast',
    },
    sort_order: 69,
  },
  {
    id: 'warn_investment_target',
    category: '警語之標示',
    description: '提及基金投資資產或標的之資訊時，是否加注「投資人申購本基金係持有基金受益憑證，而非本文提及之投資資產或標的。」（粗體）',
    check_type: 'ai',
    group_name: 'ai_warnings',
    parameters: {
      placement: 'same_page',
      required_warning_id: 'wt_investment_target',
    },
    sort_order: 70,
  },
  {
    id: 'warn_leverage',
    category: '警語之標示',
    description: '提及基金之衍生性工具/證券相關商品等槓桿投資策略時，是否揭示「投資人應留意衍生性工具/證券相關商品等槓桿投資策略所可能產生之投資風險(詳見公開說明書或投資人須知)」（粗體）',
    check_type: 'ai',
    group_name: 'ai_warnings',
    parameters: {
      placement: 'same_page',
      required_warning_id: 'wt_leverage',
    },
    sort_order: 71,
  },
  {
    id: 'warn_no_mislead_capital_protection',
    category: '警語之標示',
    description: '基金銷售文件不得誤導投資人該類基金為保本商品，或過度強調收益報酬，未衡平及以顯著方式表達風險及費用',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 72,
  },
  {
    id: 'warn_capital_protected_fund',
    category: '警語之標示',
    description: '保本型基金銷售文件如採一次扣取經理費方式，應揭露一次扣取經理費方式及中途贖回對預扣經理費並不退還等事項',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 73,
  },
  {
    id: 'warn_index_fund_fee',
    category: '警語之標示',
    description: '指數型基金收取申購/買回交易費者，需載明「投資人申購本基金時，會收取申購交易費併入基金資產，用以支付基金調整投資組合的交易成本。」',
    check_type: 'ai',
    group_name: 'ai_warnings',
    sort_order: 74,
  },
  {
    id: 'warn_etf_pre_listing',
    category: '警語之標示',
    description: 'ETF於掛牌交易前，應依申報生效函規定，於廣告以顯著方式載明「本基金上市/上櫃日前(不含當日)，經理公司不接受本基金受益權單位數之買回」等文字',
    check_type: 'ai',
    group_name: 'ai_warnings',
    sort_order: 75,
  },
  {
    id: 'warn_fsc_additional',
    category: '警語之標示',
    description: '該基金如金管會要求應於銷售文件額外加注之警語，是否已標示',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 76,
  },
  {
    id: 'warn_etf_index_perf',
    category: '警語之標示',
    description: '以ETF追蹤指數之績效或殖利率為廣告時，應揭示「以上僅為ETF追蹤指數績效或殖利率之表現，不代表本ETF基金之實際報酬率或配息率及未來績效保證，不同時間進場投資，其結果將可能不同，且並未考量交易成本。」（粗體）（當頁文宣）',
    check_type: 'ai',
    group_name: 'ai_warnings',
    parameters: {
      placement: 'same_page',
      required_warning_id: 'wt_etf_index',
    },
    sort_order: 77,
  },

  // ── 不可保證獲利 ──────────────────────────────────────────────────────────
  {
    id: 'no_guarantee_words',
    category: '不可保證獲利',
    description: '不可有類似保證獲利之字眼（保本、穩賺、優於定存、打敗通膨、政府擔保等）',
    check_type: 'ai',
    group_name: 'ai_forbidden',
    parameters: {
      semantic_group_id: 'fg_guarantee',
    },
    sort_order: 80,
  },
  {
    id: 'no_steady_perf',
    category: '不可保證獲利',
    description: '敘述基金績效收益時，不可使用「穩健」用詞',
    check_type: 'ai',
    group_name: 'ai_forbidden',
    parameters: {
      semantic_group_id: 'fg_steady',
    },
    sort_order: 81,
  },
  {
    id: 'no_predict_return',
    category: '不可保證獲利',
    description: '不可預測基金投資績效（例如目標報酬率4%~6%）',
    check_type: 'ai',
    group_name: 'ai_forbidden',
    parameters: {
      semantic_group_id: 'fg_predict_return',
    },
    sort_order: 82,
  },
  {
    id: 'no_fsc_endorsement',
    category: '不可保證獲利',
    description: '不可因金管會已核准基金募集，就宣傳該基金受金管會肯定而具有投資價值',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 83,
  },
  {
    id: 'no_low_risk_claim',
    category: '不可保證獲利',
    description: '不能因已從事期貨或選擇權交易，就宣傳該基金是「低風險」',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 84,
  },
  {
    id: 'no_risk_imbalance',
    category: '不可保證獲利',
    description: '以獲利、配息率、配息金額、ETF追蹤指數績效或殖利率為廣告時，應同時報導其風險以作為平衡報導',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 85,
  },
  {
    id: 'no_predicted_dividend',
    category: '不可保證獲利',
    description: '不可揭露基金預估配息金額、預估配息率、預估殖利率',
    check_type: 'auto_keyword',
    group_name: 'auto',
    parameters: {
      type: 'forbidden_keywords',
      keywords: ['預估配息', '預期配息', '預計配息', '預估配息率', '預估殖利率'],
      violation: '揭露預估/預期配息相關資訊',
    },
    sort_order: 86,
  },
  {
    id: 'no_annualized_dividend',
    category: '不可保證獲利',
    description: '不得揭示年化配息率或年化配息金額',
    check_type: 'auto_keyword',
    group_name: 'auto',
    parameters: {
      type: 'forbidden_keywords',
      keywords: ['年化配息率', '年化配息金額', '年化分配率', '年化配息'],
      violation: '揭示年化配息率或年化配息金額',
    },
    sort_order: 87,
  },

  // ── 其他 ──────────────────────────────────────────────────────────────────
  {
    id: 'other_no_pre_approval_ad',
    category: '其他',
    description: '尚未經金管會核准之基金，不能預先作廣告或促銷活動',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 90,
  },
  {
    id: 'other_no_predict_fx',
    category: '其他',
    description: '不可預測新臺幣匯率之走勢、不可預測個股股價或推薦個股',
    check_type: 'ai',
    group_name: 'ai_forbidden',
    sort_order: 91,
  },
  {
    id: 'other_no_attack_peers',
    category: '其他',
    description: '不可攻擊、打壓或貶低同業',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 92,
  },
  {
    id: 'other_no_interview_investor',
    category: '其他',
    description: '不得以採訪投資人之方式廣告促銷基金',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 93,
  },
  {
    id: 'other_no_fund_mgr_promo',
    category: '其他',
    description: '不可以基金經理人作為宣傳廣告訴求或標題',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 94,
  },
  {
    id: 'other_no_news_excerpt',
    category: '其他',
    description: '不可截取報章雜誌報導作為廣告訴求',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 95,
  },
  {
    id: 'other_correct_fund_name',
    category: '其他',
    description: '不得以不正確、不雅之文字或圖宣傳；基金名稱、警語及規格皆已依公開說明書完整且正確揭露',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 96,
  },
  {
    id: 'other_no_absolute_return',
    category: '其他',
    description: '不可使用「追求*%報酬率、*%年報酬率、絕對報酬率」等相關類似字眼（但公開說明書若有揭露"追求絕對報酬"則不限）',
    check_type: 'auto_keyword',
    group_name: 'auto',
    parameters: {
      type: 'forbidden_keywords',
      keywords: ['追求絕對報酬', '絕對報酬率', '%年報酬率'],
      violation: '使用「絕對報酬率/追求絕對報酬」等字眼',
    },
    sort_order: 97,
  },
  {
    id: 'other_no_exaggerate_history',
    category: '其他',
    description: '不得依過去之業績作誇大之宣傳',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 98,
  },
  {
    id: 'other_company_info',
    category: '其他',
    description: '為推廣業務之廣告文件，需列明公司名稱、地址及電話',
    check_type: 'auto_keyword',
    group_name: 'auto',
    parameters: {
      type: 'required_text',
      required_keywords: ['復華投信', '復華證券投資信託'],
      violation: '廣告文件未見公司名稱（復華投信）',
    },
    sort_order: 99,
  },
  {
    id: 'other_no_pressure_tactic',
    category: '其他',
    description: '不可以「募爆」、「下架」、「暫停申購」、「額度有限」等字眼誘導他人購買基金',
    check_type: 'auto_keyword',
    group_name: 'auto',
    parameters: {
      type: 'forbidden_keywords',
      keywords: ['募爆', '下架', '額度有限', '限額', '即將額滿', '搶購'],
      violation: '使用「募爆/下架/額度有限」等誘導性字眼',
    },
    sort_order: 100,
  },
  {
    id: 'other_credit_rating',
    category: '其他',
    description: '以信用評等為廣告者，應以顯著方式註明基金獲得信用評等之性質(等級)',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 101,
  },
  {
    id: 'other_internal_doc',
    category: '其他',
    description: '專供銷售機構使用之基金教育訓練文宣資料(須註明「僅供內部參考」字樣)，不可放置於銷售機構的櫃台或文宣資料區提供投資人自行取閱',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 102,
  },
  {
    id: 'other_no_dividend_title',
    category: '其他',
    description: '不得以配息比率或配息金額為廣告文宣之主要標題，或為廣告及文章內容之主要訴求',
    check_type: 'ai',
    group_name: 'ai_dividend',
    sort_order: 103,
  },
  {
    id: 'other_dividend_title_no_promo',
    category: '其他',
    description: '以配息為廣告標題者，不得加入基金配息資訊以外之行銷性質文字',
    check_type: 'ai',
    group_name: 'ai_dividend',
    sort_order: 104,
  },
  {
    id: 'other_stock_fund_no_monthly_div',
    category: '其他',
    description: '股票型基金、股票型被動式ETF及股票主動式ETF，不得以月配息為廣告或銷售之主要訴求',
    check_type: 'ai',
    group_name: 'ai_dividend',
    sort_order: 105,
  },
  {
    id: 'other_stock_fund_div_mechanism',
    category: '其他',
    description: '股票型基金/ETF提及配息類股時，銷售文件中需說明配息機制，包括股票配息情況及如何將股息收入轉為各期配息',
    check_type: 'ai',
    group_name: 'ai_dividend',
    sort_order: 106,
  },
  {
    id: 'other_no_sales_ranking',
    category: '其他',
    description: '不得以基金銷售排行之方式為廣告',
    check_type: 'auto_keyword',
    group_name: 'auto',
    parameters: {
      type: 'forbidden_keywords',
      keywords: ['銷售排行', '銷售冠軍', '買氣No.1', '買氣第一', '熱銷'],
      violation: '以基金銷售排行為廣告訴求',
    },
    sort_order: 107,
  },
  {
    id: 'other_no_exaggerate_hy',
    category: '其他',
    description: '針對非投資等級市場及新興市場文宣之敍述，不得以誇大方式宣傳（如過度強調未來經濟前景、殖利率高等），而忽略風險報導（中性；平衡報導）',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 108,
  },
  {
    id: 'other_press_release',
    category: '其他',
    description: '新聞稿應於文宣對外使用前向公會辦理申報',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 109,
  },
  {
    id: 'other_hy_bond_disclosure',
    category: '其他',
    description: '一般債券型基金投資於非投資等級債券及Rule 144A債券者，應於公開說明書及銷售文件中具體說明投資操作策略，及顯著揭露流動性風險、變現性風險或其他相關風險',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 110,
  },
  {
    id: 'other_balanced_disclosure',
    category: '其他',
    description: '對金融商品或服務內容之揭露如涉及利率、費用、報酬及風險時，應以衡平及顯著之方式表達',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 111,
  },
  {
    id: 'other_no_unapproved_offshore',
    category: '其他',
    description: '不得以未經金管會核准或同意生效之境外基金（不含境外ETF基金）為廣告內容',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 112,
  },
  {
    id: 'other_portfolio_yield',
    category: '其他',
    description: '不得以基金投資組合殖利率作為銷售訴求；若揭露時應同時載明計算方式及納入計算之資產項目',
    check_type: 'ai',
    group_name: 'ai_content',
    sort_order: 113,
  },

  // ── 基金模擬 ──────────────────────────────────────────────────────────────
  {
    id: 'sim_quant_only',
    category: '基金模擬',
    description: '僅適用於採數量模型操作（須有載於基金公開說明書中）之基金，可以模擬過去績效之方式為廣告內容',
    check_type: 'ai',
    group_name: 'ai_simulation',
    sort_order: 120,
  },
  {
    id: 'sim_annotation_detail',
    category: '基金模擬',
    description: '以模擬績效為廣告訴求時，應針對運算模型及假設條件加以詳細附注說明，並對其風險作平衡報導，且字體不得小於該模擬績效廣告部分之字體',
    check_type: 'ai',
    group_name: 'ai_simulation',
    sort_order: 121,
  },
  {
    id: 'sim_min_2years',
    category: '基金模擬',
    description: '模擬資料期間：不得低於2年',
    check_type: 'ai',
    group_name: 'ai_simulation',
    sort_order: 122,
  },
  {
    id: 'sim_source',
    category: '基金模擬',
    description: '模擬資料來源：限Lipper、晨星、嘉實、公會、Bloomberg、台灣經濟新報、各大交易所、Cmoney',
    check_type: 'auto_keyword',
    group_name: 'auto',
    parameters: {
      type: 'conditional_required',
      trigger_keywords: ['模擬', '回測'],
      required_keywords: ['Lipper', '晨星', '嘉實', '公會', 'Bloomberg', '台灣經濟新報', 'Cmoney'],
      violation: '模擬績效未標注符合規定之資料來源',
    },
    sort_order: 123,
  },
  {
    id: 'sim_model_note',
    category: '基金模擬',
    description: '模型假設基礎：應於廣告文宣資料加注「基金之操作模型請詳閱公開說明書」',
    check_type: 'auto_keyword',
    group_name: 'auto',
    parameters: {
      type: 'conditional_required',
      trigger_keywords: ['模擬', '回測'],
      required_keywords: ['基金之操作模型請詳閱公開說明書'],
      violation: '模擬績效未加注「基金之操作模型請詳閱公開說明書」',
    },
    sort_order: 124,
  },
  {
    id: 'sim_warning_text',
    category: '基金模擬',
    description: '模擬警語：「以上僅為歷史資料模擬回測結果，不代表本基金之未來績效保證，不同時間進行模擬操作，其結果亦可能不同。」',
    check_type: 'auto_keyword',
    group_name: 'auto',
    parameters: {
      type: 'conditional_required',
      trigger_keywords: ['模擬', '回測'],
      required_keywords: ['歷史資料模擬回測結果', '不代表本基金之未來績效保證'],
      violation: '使用模擬績效廣告，但未加注規定的模擬警語',
    },
    sort_order: 125,
  },
  {
    id: 'sim_risk_balance',
    category: '基金模擬',
    description: '風險平衡報導：年化標準差、或績效報酬率走勢圖、或期間最大下跌風險、或自相對高點回本天數',
    check_type: 'ai',
    group_name: 'ai_simulation',
    sort_order: 126,
  },

  // ── 基本警語存在 ──────────────────────────────────────────────────────────
  {
    id: 'general_warning_present',
    category: '警語之標示',
    description: '文宣最後應包含基本警語：「投資一定有風險，基金投資有賺有賠，申購前應詳閱公開說明書」或完整文宣綜合警語',
    check_type: 'auto_keyword',
    group_name: 'auto',
    parameters: {
      type: 'required_text',
      required_keywords: ['投資一定有風險', '基金投資有賺有賠', '申購前應詳閱'],
      violation: '文宣末未見基本警語「投資一定有風險，基金投資有賺有賠，申購前應詳閱公開說明書」',
    },
    sort_order: 60,
  },
];

console.log(`Seeding ${checkItems.length} check items...`);
for (const item of checkItems) upsertCheckItem(item);

// ─── 3. Forbidden term groups ────────────────────────────────────────────────

const forbiddenTerms = [
  {
    id: 'fg_guarantee_1', category: '不可保證獲利', check_item_id: 'no_guarantee_words',
    term: '保本', semantic_group: ['保本', '不會虧', '不虧損', '零虧損', '確保本金', '本金無虞', '本金安全'],
  },
  {
    id: 'fg_guarantee_2', category: '不可保證獲利', check_item_id: 'no_guarantee_words',
    term: '穩賺', semantic_group: ['穩賺', '大賺', '必賺', '保證賺', '一定賺', '穩定獲利'],
  },
  {
    id: 'fg_guarantee_3', category: '不可保證獲利', check_item_id: 'no_guarantee_words',
    term: '優於定存', semantic_group: ['優於定存', '贏過定存', '打敗定存', '高於定存', '比定存好'],
  },
  {
    id: 'fg_guarantee_4', category: '不可保證獲利', check_item_id: 'no_guarantee_words',
    term: '打敗通膨', semantic_group: ['打敗通膨', '抗通膨', '勝過通膨', '抵抗通脹'],
  },
  {
    id: 'fg_guarantee_5', category: '不可保證獲利', check_item_id: 'no_guarantee_words',
    term: '政府擔保', semantic_group: ['政府擔保', '政府保證', '國家擔保', '主權擔保'],
  },
  {
    id: 'fg_steady_1', category: '不可保證獲利', check_item_id: 'no_steady_perf',
    term: '穩健收益', semantic_group: ['穩健收益', '穩健報酬', '穩健績效', '穩健獲利', '穩健成長'],
  },
  {
    id: 'fg_predict_1', category: '不可保證獲利', check_item_id: 'no_predict_return',
    term: '目標報酬率', semantic_group: ['目標報酬率', '目標收益率', '預期報酬', '預估報酬率', '預計報酬'],
  },
];

console.log(`Seeding ${forbiddenTerms.length} forbidden term groups...`);
for (const t of forbiddenTerms) upsertForbiddenTerm(t);

// ─── 4. In-text warning texts ─────────────────────────────────────────────────

const warningTexts = [
  {
    id: 'wt_individual_stock',
    name: '提及個股警語',
    trigger_keywords: ['個股', '台積電', '聯發科', '鴻海', '股票代號', '持股'],
    trigger_type: 'semantic',
    warning_text: '個股與相關數據資料僅供說明之用，不代表投資決策之建議。',
    placement_rule: 'same_page',
    format_requirements: { bold: true },
  },
  {
    id: 'wt_example_figure',
    name: '舉例說明警語',
    trigger_keywords: ['舉例', '例如', '假設', '以下試算', '模擬情境'],
    trigger_type: 'semantic',
    warning_text: '以上資料為舉例說明，不代表未來實際績效。',
    placement_rule: 'same_page',
    format_requirements: { bold: true },
  },
  {
    id: 'wt_dca',
    name: '定時定額/投資方法論警語',
    trigger_keywords: ['定時定額', '複合投資法', '好利high', '智慧扣款', '定期投資'],
    trigger_type: 'semantic',
    warning_text: '投資人因不同時間進場，將有不同之投資績效，過去之績效亦不代表未來績效之保證。',
    placement_rule: 'same_page',
    format_requirements: { bold: true },
  },
  {
    id: 'wt_dividend',
    name: '配息廣告警語',
    trigger_keywords: ['配息率', '配息金額', '月配息', '季配息', '年配息', '分配收益'],
    trigger_type: 'semantic',
    warning_text: '基金配息不代表基金實際報酬，且過去配息不代表未來配息；基金淨值可能因市場因素而上下波動。',
    placement_rule: 'document_end',
    format_requirements: { bold: true },
  },
  {
    id: 'wt_economic_forecast',
    name: '經濟走勢預測警語',
    trigger_keywords: ['經濟走勢', '市場預測', '展望', '預期', '預測'],
    trigger_type: 'semantic',
    warning_text: '本文提及之經濟走勢預測不必然代表本基金之績效，本基金投資風險請詳閱基金公開說明書。',
    placement_rule: 'document_end',
    format_requirements: { bold: true },
  },
  {
    id: 'wt_investment_target',
    name: '投資資產/標的警語',
    trigger_keywords: ['投資標的', '投資資產', '持有標的', '投資於'],
    trigger_type: 'semantic',
    warning_text: '投資人申購本基金係持有基金受益憑證，而非本文提及之投資資產或標的。',
    placement_rule: 'same_page',
    format_requirements: { bold: true },
  },
  {
    id: 'wt_leverage',
    name: '衍生性工具/槓桿警語',
    trigger_keywords: ['衍生性工具', '選擇權', '期貨', '槓桿策略', '槓桿操作'],
    trigger_type: 'semantic',
    warning_text: '投資人應留意衍生性工具/證券相關商品等槓桿投資策略所可能產生之投資風險(詳見公開說明書或投資人須知)。',
    placement_rule: 'same_page',
    format_requirements: { bold: true },
  },
  {
    id: 'wt_etf_index',
    name: 'ETF追蹤指數績效/殖利率警語',
    trigger_keywords: ['ETF追蹤指數', '追蹤指數績效', '指數績效', '指數殖利率'],
    trigger_type: 'semantic',
    warning_text: '以上僅為ETF追蹤指數績效或殖利率之表現，不代表本ETF基金之實際報酬率或配息率及未來績效保證，不同時間進場投資，其結果將可能不同，且並未考量交易成本。',
    placement_rule: 'same_page',
    format_requirements: { bold: true },
  },
  {
    id: 'wt_simulation',
    name: '模擬回測警語',
    trigger_keywords: ['模擬', '回測', '歷史資料模擬'],
    trigger_type: 'semantic',
    warning_text: '以上僅為歷史資料模擬回測結果，不代表本基金之未來績效保證，不同時間進行模擬操作，其結果亦可能不同。',
    placement_rule: 'same_page',
    format_requirements: { bold: true },
  },
  {
    id: 'wt_rr_rating',
    name: '風險報酬等級(RR)警語',
    trigger_keywords: ['RR1', 'RR2', 'RR3', 'RR4', 'RR5', '風險報酬等級'],
    trigger_type: 'exact',
    warning_text: '綜合評估本基金投資組合及風險、以計算過去5年之淨值波動度為原則，參考「中華民國證券投資信託暨顧問商業同業公會基金風險報酬等級分類標準」並與同類型基金淨值波動度比較，訂定本基金之風險報酬等級。',
    placement_rule: 'same_page',
    format_requirements: { bold: true },
  },
  {
    id: 'wt_portfolio_yield',
    name: '投資組合殖利率揭露警語',
    trigger_keywords: ['投資組合殖利率', '平均殖利率', '到期殖利率', '現金殖利率'],
    trigger_type: 'semantic',
    warning_text: '投資組合平均殖利率不代表基金實際投資報酬率或配息率，亦不做為基金收益及淨值之推估。',
    placement_rule: 'same_page',
    format_requirements: { bold: true },
  },
];

console.log(`Seeding ${warningTexts.length} warning texts...`);
for (const wt of warningTexts) upsertWarningText(wt);

// ─── 5. Fund warnings from 警語大全 ──────────────────────────────────────────

const BASE_FUND_WARNING = '本基金經金管會核准或同意生效，惟不表示絕無風險。本公司以往之經理績效不保證基金之最低投資收益；本公司除盡善良管理人之注意義務外，不負責基金之盈虧，亦不保證最低之收益，投資人申購前應詳閱基金公開說明書。有關基金應負擔之費用（境外基金含分銷費用）已揭露於基金之公開說明書或投資人須知中，投資人可向本公司及基金之銷售機構索取，或至公開資訊觀測站、境外基金資訊觀測站及本公司網站(https://www.fhtrust.com.tw)中查詢。';

const DIVIDEND_BASE = BASE_FUND_WARNING + '基金配息不代表基金實際報酬，且過去配息不代表未來配息；基金淨值可能因市場因素而上下波動。';

const HIGH_RISK_BOND_HEAVY = '以投資非投資等級債券為訴求之基金適合尋求投資固定收益之潛在收益且能承受較高風險之非保守型投資人。投資人投資以非投資等級債券為訴求之基金不宜占其投資組合過高之比重。本基金經金融監督管理委員會核准或申報生效，惟不表示絕無風險。由於非投資等級債券之信用評等未達投資等級或未經信用評等，且對利率變動的敏感度甚高，故基金可能會因利率上升、市場流動性下降，或債券發行機構違約不支付本金、利息或破產而蒙受虧損。本基金不適合無法承擔相關風險之投資人。本公司以往之經理績效不保證基金之最低投資收益；本公司除盡善良管理人之注意義務外，不負責基金之盈虧，亦不保證最低之收益，投資人申購前應詳閱基金公開說明書。';

const fundWarnings = [
  // ── 國內股票型、平衡型、貨幣市場型（無配息）─────────────────────────────
  {
    id: 'fw_domestic_general',
    fund_name: '（通用）復華基金/高成長/數位經濟/中小精選/全方位/貨幣市場/有利貨幣',
    aliases: ['復華復華基金', '復華高成長基金', '復華數位經濟基金', '復華中小精選基金', '復華全方位基金', '復華貨幣市場基金', '復華有利貨幣市場基金'],
    annotation_text: null,
    annotation_format: null,
    comprehensive_warning: BASE_FUND_WARNING,
    warning_category: '國內股票型/平衡型/貨幣市場型',
  },
  // ── 復華台灣好收益基金 ────────────────────────────────────────────────────
  {
    id: 'fw_taiwan_good_yield',
    fund_name: '復華台灣好收益基金',
    aliases: ['台灣好收益'],
    annotation_text: null,
    annotation_format: null,
    comprehensive_warning: DIVIDEND_BASE,
    warning_category: '國內股票型/平衡型',
  },
  // ── 復華台灣科技高股息基金 ────────────────────────────────────────────────
  {
    id: 'fw_tw_tech_div',
    fund_name: '復華台灣科技高股息基金',
    aliases: ['台灣科技高股息'],
    annotation_text: '（基金之配息來源可能為本金及收益平準金且本基金並無保證收益及配息）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: '本基金經臺灣集中保管結算所股份有限公司申報生效，惟不表示絕無風險。本公司以往之經理績效不保證基金之最低投資收益；本公司除盡善良管理人之注意義務外，不負責基金之盈虧，亦不保證最低之收益，投資人申購前應詳閱基金公開說明書。有關基金應負擔之費用已揭露於基金之公開說明書或投資人須知中。基金配息不代表基金實際報酬，且過去配息不代表未來配息；基金淨值可能因市場因素而上下波動。本基金配息可能由基金的收益、本金或收益平準金中支付。任何涉及由本金或收益平準金支出的部份，可能導致原始投資金額減損。本基金配息前未先扣除應負擔之相關費用。',
    warning_category: '國內股票型/ETF/配息涉及本金',
  },
  // ── 復華傳家基金 ──────────────────────────────────────────────────────────
  {
    id: 'fw_heritage',
    fund_name: '復華傳家基金',
    aliases: ['傳家基金'],
    annotation_text: null,
    comprehensive_warning: '為提升基金操作彈性及投資效率之目的，本基金得依信託契約規定調整股票投資比例。' + BASE_FUND_WARNING,
    warning_category: '國內平衡型/動態配置',
  },
  // ── 復華傳家二號基金 ──────────────────────────────────────────────────────
  {
    id: 'fw_heritage2',
    fund_name: '復華傳家二號基金',
    aliases: ['傳家二號'],
    annotation_text: null,
    comprehensive_warning: '為提升基金操作彈性及投資效率之目的，本基金得依信託契約規定調整股票投資比例。' + BASE_FUND_WARNING,
    warning_category: '國內平衡型/動態配置',
  },
  // ── 復華人生目標基金 ──────────────────────────────────────────────────────
  {
    id: 'fw_life_target',
    fund_name: '復華人生目標基金',
    aliases: ['人生目標基金'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING,
    warning_category: '國內目標日期型',
  },
  // ── 復華神盾基金 ──────────────────────────────────────────────────────────
  {
    id: 'fw_shield',
    fund_name: '復華神盾基金',
    aliases: ['神盾基金'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING,
    warning_category: '國內多重資產型',
  },
  // ── 國外股票型/平衡型（一般）────────────────────────────────────────────
  {
    id: 'fw_intl_equity_general',
    fund_name: '復華亞太成長基金等（國外股票型一般）',
    aliases: ['復華亞太成長基金', '復華全球大趨勢基金', '復華華人世紀基金', '復華全球原物料基金', '復華大中華中小策略基金', '復華東協世紀基金', '復華全球消費基金', '復華美國新星基金', '復華全球物聯網科技基金', '復華亞太神龍科技基金'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING,
    warning_category: '國外股票型/平衡型（一般）',
  },
  // ── 復華中國新經濟A股基金 ─────────────────────────────────────────────────
  {
    id: 'fw_china_a',
    fund_name: '復華中國新經濟A股基金',
    aliases: ['中國新經濟A股'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING + '本基金得投資於大陸地區有價證券，其投資上限以基金信託契約及法令規定為準，投資人亦須留意大陸市場特定政治、經濟與市場等投資風險。',
    warning_category: '國外股票型/大陸地區',
  },
  // ── 國外平衡型：有相當比重投資非投資等級債券且配息來源可能為本金 ────────
  {
    id: 'fw_china_balance',
    fund_name: '復華中國新經濟平衡基金',
    aliases: ['中國新經濟平衡'],
    annotation_text: '（本基金有相當比重投資於非投資等級之高風險債券且基金之配息來源可能為本金）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: HIGH_RISK_BOND_HEAVY,
    warning_category: '國外平衡型/高風險債+配息涉及本金',
  },
  // ── 復華全球平衡基金 ──────────────────────────────────────────────────────
  {
    id: 'fw_global_balance',
    fund_name: '復華全球平衡基金',
    aliases: ['全球平衡基金'],
    annotation_text: '（本基金有相當比重投資於非投資等級之高風險債券）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: HIGH_RISK_BOND_HEAVY,
    warning_category: '國外平衡型/高風險債',
  },
  // ── 復華亞太平衡基金 ──────────────────────────────────────────────────────
  {
    id: 'fw_apac_balance',
    fund_name: '復華亞太平衡基金',
    aliases: ['亞太平衡基金'],
    annotation_text: '（本基金有相當比重投資於非投資等級之高風險債券）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: HIGH_RISK_BOND_HEAVY,
    warning_category: '國外平衡型/高風險債',
  },
  // ── 主動式ETF：復華台灣未來50 ────────────────────────────────────────────
  {
    id: 'fw_tw_future50',
    fund_name: '復華台灣未來50主動式ETF基金',
    aliases: ['台灣未來50', '未來50ETF'],
    annotation_text: '（基金之配息來源可能為收益平準金）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: BASE_FUND_WARNING + '本基金配息可能由基金的收益或收益平準金中支付。任何涉及由收益平準金支出的部份，可能導致原始投資金額減損。',
    warning_category: '主動式ETF/配息涉及收益平準金',
  },
  // ── 復華全球金融股票入息主動式ETF ────────────────────────────────────────
  {
    id: 'fw_global_fin_equity_etf',
    fund_name: '復華全球金融股票入息主動式ETF基金',
    aliases: ['全球金融股票入息ETF', '全球金融股票入息主動式ETF'],
    annotation_text: '（基金之配息來源可能為收益平準金且本基金並無保證收益及配息）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: BASE_FUND_WARNING + '本基金配息可能由基金的收益或收益平準金中支付。任何涉及由收益平準金支出的部份，可能導致原始投資金額減損。',
    warning_category: '主動式ETF/配息涉及收益平準金',
  },
  // ── 復華全球金融債券入息主動式ETF ────────────────────────────────────────
  {
    id: 'fw_global_fin_bond_etf',
    fund_name: '復華全球金融債券入息主動式ETF基金',
    aliases: ['全球金融債券入息ETF', '全球金融債券入息主動式ETF'],
    annotation_text: '（本基金有一定比重得投資於非投資等級之高風險債券且本基金並無保證收益及配息）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: HIGH_RISK_BOND_HEAVY,
    warning_category: '主動式ETF/高風險債',
  },
  // ── 指數股票型ETF：復華滬深300 ────────────────────────────────────────────
  {
    id: 'fw_csi300',
    fund_name: '復華滬深300 A股基金',
    aliases: ['滬深300', '滬深300A股'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING + '本基金得投資於大陸地區有價證券，其投資上限以基金信託契約及法令規定為準，投資人亦須留意大陸市場特定政治、經濟與市場等投資風險。',
    warning_category: '指數股票型ETF/大陸地區',
  },
  // ── 復華恒生單日正向二倍基金 ─────────────────────────────────────────────
  {
    id: 'fw_hsi_2x',
    fund_name: '復華恒生單日正向二倍基金',
    aliases: ['恒生正向二倍', '恒生2X'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING + '本基金具有槓桿風險，其投資盈虧深受市場波動與複利效果影響，與傳統指數股票型基金不同。本基金不適合追求長期投資且不熟悉基金以追求單日報酬為投資目標之投資人。',
    warning_category: '槓桿/反向ETF',
  },
  // ── 復華恒生單日反向一倍基金 ─────────────────────────────────────────────
  {
    id: 'fw_hsi_inv1x',
    fund_name: '復華恒生單日反向一倍基金',
    aliases: ['恒生反向一倍', '恒生-1X'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING + '本基金具有反向風險，其投資盈虧深受市場波動與複利效果影響，與傳統指數股票型基金不同。本基金不適合追求長期投資且不熟悉基金以追求單日報酬為投資目標之投資人。',
    warning_category: '槓桿/反向ETF',
  },
  // ── 以配息來源可能為收益平準金之債券ETF ──────────────────────────────────
  {
    id: 'fw_bond_etf_equalisation',
    fund_name: '復華1至5年期非投資等級債券基金等（收益平準金）',
    aliases: ['復華1至5年期非投資等級債券基金', '復華新興市場10年期以上債券基金', '復華富時不動產證券化基金', '復華15年期以上能源業債券ETF基金', '復華15年期以上製藥業債券ETF基金', '復華新興市場企業債券ETF基金', '復華美國20年期以上公債ETF基金', '復華20年期以上A3級以上公司債券ETF基金', '復華1至5年期美元特選信用債券ETF基金'],
    annotation_text: '（基金之配息來源可能為收益平準金）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: BASE_FUND_WARNING + '本基金配息可能由基金的收益或收益平準金中支付。任何涉及由收益平準金支出的部份，可能導致原始投資金額減損。',
    warning_category: '債券ETF/配息涉及收益平準金',
  },
  // ── 復華富時台灣高股息低波動基金 ─────────────────────────────────────────
  {
    id: 'fw_tw_high_div_low_vol',
    fund_name: '復華富時台灣高股息低波動基金',
    aliases: ['台灣高股息低波動', '富時台灣高股息低波動'],
    annotation_text: '（基金之配息來源可能為收益平準金且本基金並無保證收益及配息）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: BASE_FUND_WARNING + '本基金配息可能由基金的收益或收益平準金中支付。任何涉及由收益平準金支出的部份，可能導致原始投資金額減損。',
    warning_category: '被動式ETF/配息涉及收益平準金',
  },
  // ── 復華台灣科技優息ETF基金 ───────────────────────────────────────────────
  {
    id: 'fw_tw_tech_yield_etf',
    fund_name: '復華台灣科技優息ETF基金',
    aliases: ['台灣科技優息ETF'],
    annotation_text: '（基金之配息來源可能為收益平準金且本基金並無保證收益及配息）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: BASE_FUND_WARNING + '本基金配息可能由基金的收益或收益平準金中支付。任何涉及由收益平準金支出的部份，可能導致原始投資金額減損。',
    warning_category: '被動式ETF/配息涉及收益平準金',
  },
  // ── 復華南非幣系列 ────────────────────────────────────────────────────────
  {
    id: 'fw_sa_rand',
    fund_name: '復華南非幣短期/長期收益基金',
    aliases: ['復華南非幣短期收益基金', '復華南非幣長期收益基金'],
    annotation_text: '（本基金有一定比重得投資於非投資等級之高風險債券且基金之配息來源可能為本金）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: HIGH_RISK_BOND_HEAVY,
    warning_category: '國外債券型/高風險債+配息涉及本金',
  },
  // ── 復華全球債券基金/全球短期收益基金 ────────────────────────────────────
  {
    id: 'fw_global_bond',
    fund_name: '復華全球債券基金/復華全球短期收益基金',
    aliases: ['復華全球債券基金', '復華全球短期收益基金'],
    annotation_text: '（本基金有一定比重得投資於非投資等級之高風險債券）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: HIGH_RISK_BOND_HEAVY,
    warning_category: '國外債券型/一定比重高風險債',
  },
  // ── 復華新興市場非投資等級債券基金 ──────────────────────────────────────
  {
    id: 'fw_em_hy',
    fund_name: '復華新興市場非投資等級債券基金',
    aliases: ['新興市場非投資等級債券', '新興市場高收益債'],
    annotation_text: '（基金之配息來源可能為本金）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: HIGH_RISK_BOND_HEAVY,
    warning_category: '非投資等級債券型/配息涉及本金',
  },
  // ── 復華新興市場短期收益基金 ──────────────────────────────────────────────
  {
    id: 'fw_em_st',
    fund_name: '復華新興市場短期收益基金',
    aliases: ['新興市場短期收益'],
    annotation_text: '（本基金有相當比重投資於非投資等級之高風險債券）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: HIGH_RISK_BOND_HEAVY,
    warning_category: '非投資等級債券型',
  },
  // ── 復華十年到期新興市場債券/精選新興市場債券基金 ────────────────────────
  {
    id: 'fw_10yr_em_bond',
    fund_name: '復華十年到期新興市場債券基金/精選新興市場債券基金',
    aliases: ['復華十年到期新興市場債券基金', '復華十年到期精選新興市場債券基金'],
    annotation_text: '（本基金有相當比重投資於非投資等級之高風險債券且基金之配息來源可能為本金）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: HIGH_RISK_BOND_HEAVY,
    warning_category: '非投資等級債券型/配息涉及本金',
  },
  // ── 組合型基金：高風險債 ──────────────────────────────────────────────────
  {
    id: 'fw_combo_hy_plain',
    fund_name: '復華奧林匹克全球組合基金/全球債券組合基金/高益策略組合基金/全球戰略配置強基金',
    aliases: ['復華奧林匹克全球組合基金', '復華全球債券組合基金', '復華高益策略組合基金', '復華全球戰略配置強基金'],
    annotation_text: '（本基金有相當比重投資於持有非投資等級高風險債券之基金）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: HIGH_RISK_BOND_HEAVY,
    warning_category: '國外組合型/投資高風險債基金',
  },
  // ── 復華奧林匹克全球優勢組合基金 ─────────────────────────────────────────
  {
    id: 'fw_combo_hy_plus_principal',
    fund_name: '復華奧林匹克全球優勢組合基金',
    aliases: ['奧林匹克全球優勢組合'],
    annotation_text: '（本基金有相當比重投資於持有非投資等級高風險債券之基金且基金之配息來源可能為本金）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: HIGH_RISK_BOND_HEAVY,
    warning_category: '國外組合型/投資高風險債基金+配息涉及本金',
  },
  // ── 復華全球資產證券化基金 ────────────────────────────────────────────────
  {
    id: 'fw_abs',
    fund_name: '復華全球資產證券化基金',
    aliases: ['全球資產證券化'],
    annotation_text: '（基金之配息來源可能為本金）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: BASE_FUND_WARNING + '本基金配息可能由基金的收益或本金中支付。任何涉及由本金支出的部份，可能導致原始投資金額減損。',
    warning_category: '資產證券化型/配息涉及本金',
  },
  // ── 復華美元非投資等級債券指數基金 ──────────────────────────────────────
  {
    id: 'fw_usd_hy_idx',
    fund_name: '復華美元非投資等級債券指數基金',
    aliases: ['美元非投資等級債券指數'],
    annotation_text: '（基金之配息來源可能為本金）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: HIGH_RISK_BOND_HEAVY,
    warning_category: '指數型/非投資等級債券/配息涉及本金',
  },
  // ── 復華新興市場3年期以上美元主權債指數基金 ──────────────────────────────
  {
    id: 'fw_em_sovereign_idx',
    fund_name: '復華新興市場3年期以上美元主權及類主權債券指數基金',
    aliases: ['新興市場主權債指數', '復華新興市場3年期以上美元主權'],
    annotation_text: '（本基金有相當比重投資於非投資等級之高風險債券）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: HIGH_RISK_BOND_HEAVY,
    warning_category: '指數型/非投資等級債券',
  },
  // ── 復華新興亞洲3至10年期美元債券指數基金 ────────────────────────────────
  {
    id: 'fw_em_asia_bond_idx',
    fund_name: '復華新興亞洲3至10年期美元債券指數基金',
    aliases: ['新興亞洲美元債指數', '復華新興亞洲3至10年期'],
    annotation_text: '（本基金有相當比重投資於非投資等級之高風險債券）',
    annotation_format: { bold: true, distinctive_color: true, same_size: true, immediately_after: true },
    comprehensive_warning: HIGH_RISK_BOND_HEAVY,
    warning_category: '指數型/非投資等級債券',
  },
  // ── 復華中國5G通信ETF ─────────────────────────────────────────────────────
  {
    id: 'fw_china_5g',
    fund_name: '復華中國5G通信ETF基金',
    aliases: ['中國5G通信ETF', '5G通信ETF'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING + '本基金得投資於大陸地區有價證券，投資人須留意大陸市場相關投資風險。',
    warning_category: '指數股票型ETF/大陸地區',
  },
  // ── 復華美國標普500成長ETF ────────────────────────────────────────────────
  {
    id: 'fw_sp500_growth',
    fund_name: '復華美國標普500成長ETF基金',
    aliases: ['標普500成長ETF', 'S&P500成長ETF'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING,
    warning_category: '指數股票型ETF',
  },
  // ── 復華日本護城河優勢龍頭企業ETF ────────────────────────────────────────
  {
    id: 'fw_japan_moat',
    fund_name: '復華日本護城河優勢龍頭企業ETF基金',
    aliases: ['日本護城河ETF', '日本龍頭企業ETF'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING,
    warning_category: '指數股票型ETF',
  },
  // ── 傘型基金通則（含各子基金）────────────────────────────────────────────
  {
    id: 'fw_umbrella_hk',
    fund_name: '復華香港ETF傘型基金',
    aliases: ['香港ETF傘型基金', '復華香港ETF'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING,
    warning_category: '傘型基金/ETF',
  },
  {
    id: 'fw_global_income_etf_umbrella',
    fund_name: '復華全球收益ETF傘型基金',
    aliases: ['全球收益ETF傘型基金'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING,
    warning_category: '傘型基金/ETF',
  },
  {
    id: 'fw_special_bond_umbrella',
    fund_name: '復華特選債券傘型基金',
    aliases: ['特選債券傘型基金'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING,
    warning_category: '傘型基金/債券',
  },
  {
    id: 'fw_multi_asset_umbrella',
    fund_name: '復華多元資產傘型基金',
    aliases: ['多元資產傘型基金'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING,
    warning_category: '傘型基金/多元資產',
  },
  {
    id: 'fw_selected_usd_bond_umbrella',
    fund_name: '復華精選美元債券傘型基金',
    aliases: ['精選美元債券傘型基金'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING,
    warning_category: '傘型基金/債券',
  },
  {
    id: 'fw_a_grade_bond_umbrella',
    fund_name: '復華A級債券傘型基金',
    aliases: ['A級債券傘型基金'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING,
    warning_category: '傘型基金/債券',
  },
  {
    id: 'fw_equity_bond_idx_umbrella',
    fund_name: '復華股債指數傘型基金',
    aliases: ['股債指數傘型基金'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING,
    warning_category: '傘型基金/指數',
  },
  {
    id: 'fw_equity_bond_idx2_umbrella',
    fund_name: '復華股債指數二號傘型基金',
    aliases: ['股債指數二號傘型基金'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING,
    warning_category: '傘型基金/指數',
  },
  // ── 復華台灣智能基金（國內組合型）───────────────────────────────────────
  {
    id: 'fw_tw_smart',
    fund_name: '復華台灣智能基金',
    aliases: ['台灣智能基金'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING,
    warning_category: '國內組合型',
  },
  // ── 復華新興債股動力組合基金（國外組合型）──────────────────────────────
  {
    id: 'fw_em_bond_equity',
    fund_name: '復華新興債股動力組合基金',
    aliases: ['新興債股動力組合'],
    annotation_text: null,
    comprehensive_warning: BASE_FUND_WARNING,
    warning_category: '國外組合型（一般）',
  },
];

console.log(`Seeding ${fundWarnings.length} fund warnings...`);
for (const fw of fundWarnings) upsertFundWarning(fw);

console.log('\n✅ Seed completed successfully.');
console.log(`   Check items: ${checkItems.length}`);
console.log(`   Forbidden term groups: ${forbiddenTerms.length}`);
console.log(`   Warning texts: ${warningTexts.length}`);
console.log(`   Fund warnings: ${fundWarnings.length}`);
db.close();
