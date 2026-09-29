"""
稻谷查查 - 5维度归因计算
整合板块联动、盘口竞价、筹码分布、情绪周期、资金席位
"""
import pandas as pd
import numpy as np

TUSHARE_TOKEN = '42f7594e9640ff73a5b018a021a4141ab9012c37d6e6d599bb6221eb'
TUSHARE_URL = 'https://t.xiaodefa.top/'

def call_api(api_name, params):
    import requests
    payload = {"api_name": api_name, "token": TUSHARE_TOKEN, "params": params}
    resp = requests.post(TUSHARE_URL, json=payload, timeout=15)
    result = resp.json()
    if result.get('code') != 0:
        return None
    fields = result['data']['fields']
    items = result['data']['items']
    return {f: [item[i] for item in items] for i, f in enumerate(fields)}


def calc_dim1_sector(ts_code, t_date, stock_df):
    """维度一：板块联动"""
    industry_map = {
        '000733': '元器件', '002475': '电子制造', '600267': '化学制药',
        '600722': '化工', '600519': '白酒', '300750': '新能源汽车',
    }
    code_num = ts_code.split('.')[0]
    industry = industry_map.get(code_num, '其他')

    sector_map = {
        '元器件': '801643.SI', '电子制造': '801643.SI', '化学制药': '801512.SI',
        '化工': '801033.SI', '白酒': '801156.SI', '新能源汽车': '801723.SI',
    }
    idx_code = sector_map.get(industry, '801643.SI')

    try:
        sector_d = call_api("index_daily", {"ts_code": idx_code, "start_date": "20260901", "end_date": t_date})
        if sector_d and 'pct_chg' in sector_d and sector_d['pct_chg']:
            sector_pct = round(float(sector_d['pct_chg'][-1]), 2)
        else:
            sector_pct = 0.0
    except:
        sector_pct = 0.0

    stock_t = stock_df[stock_df['trade_date'] == t_date]
    stock_t1 = stock_df[stock_df['trade_date'] != t_date].iloc[-1] if len(stock_df) > 1 else None
    stock_pct = float(stock_t.iloc[0]['pct_chg']) if len(stock_t) > 0 else 0.0
    alpha = round(stock_pct - sector_pct, 2)

    sentiment = '强势' if alpha > 1 else ('弱势' if alpha < -1 else '跟随')
    comment = '个股强于板块' if alpha > 0 else '个股弱于板块'

    return {
        'industry': industry,
        'sector_pct': f'{sector_pct:+.2f}%',
        'sector_comment': comment,
        'alpha': f'{alpha:+.2f}%',
        'alpha_comment': f'市场周期{comment}',
    }


def calc_dim2_auction(t_date, stock_df):
    """维度二：盘口竞价"""
    stock_t = stock_df[stock_df['trade_date'] == t_date]
    stock_t1 = stock_df[stock_df['trade_date'] != t_date].iloc[-1] if len(stock_df) > 1 else None

    if len(stock_t) == 0 or stock_t1 is None:
        return {
            'auction_open_pct': 'N/A', 'auction_comment': '数据不足',
            't1_candle': 'N/A', 'candle_comment': '数据不足',
            't1_tail_action': 'N/A', 'tail_comment': '数据不足',
        }

    t_close = float(stock_t.iloc[0]['close'])
    t_open = float(stock_t.iloc[0]['open'])
    t1_close = float(stock_t1['close'])
    t1_open = float(stock_t1['open'])
    t1_high = float(stock_t1['high'])
    t1_low = float(stock_t1['low'])

    auction_pct = round((t_open - t1_close) / t1_close * 100, 2) if t1_close > 0 else 0.0

    if auction_pct > 2:
        auction_comment = '高开，有异动'
    elif auction_pct < -2:
        auction_comment = '低开，抛压明显'
    else:
        auction_comment = '正常平开'

    # T-1日K线形态
    is_yang = t1_close > t1_open
    t1_range = t1_high - t1_low if t1_high > t1_low else 1
    upper_shadow = (t1_high - t1_close) / t1_range if t1_range > 0 else 0
    lower_shadow = (t1_close - t1_low) / t1_range if t1_range > 0 else 0

    if is_yang and upper_shadow > 0.5:
        candle = '阳线+长上影'
        candle_comment = '上方有压力'
    elif is_yang and lower_shadow > 0.5:
        candle = '阳线+长下影'
        candle_comment = '下方有支撑'
    elif not is_yang and upper_shadow > 0.5:
        candle = '阴线+长上影'
        candle_comment = '尾盘有出货迹象'
    elif not is_yang and lower_shadow > 0.5:
        candle = '阴线+长下影'
        candle_comment = '下方支撑较强'
    elif not is_yang:
        candle = '阴线'
        candle_comment = '空方占优'
    else:
        candle = '阳线'
        candle_comment = '多方占优'

    # T-1尾盘评判
    if upper_shadow > 0.6:
        tail_action = '尾盘冲高回落'
        tail_comment = '压力明显'
    elif lower_shadow > 0.6:
        tail_action = '尾盘企稳拉升'
        tail_comment = '资金托底'
    else:
        tail_action = '尾盘正常'
        tail_comment = '无异动'

    return {
        'auction_open_pct': f'{auction_pct:+.2f}%',
        'auction_comment': auction_comment,
        't1_candle': candle,
        'candle_comment': candle_comment,
        't1_tail_action': tail_action,
        'tail_comment': tail_comment,
    }


def calc_dim3_chip(ts_code, t_date, stock_df):
    """维度三：筹码分布"""
    code_num = ts_code.split('.')[0]

    try:
        basic = call_api("stock_basic", {"ts_code": ts_code})
        industry = basic.get('industry', ['其他'])[0] if basic and 'industry' in basic else '其他'
    except:
        industry = '其他'

    df_120 = stock_df.tail(120).copy()
    if len(df_120) < 30:
        return {
            'win_rate': 'N/A', 'win_rate_comment': '数据不足',
            'dist_ma120': 'N/A', 'ma120_comment': '数据不足',
            'dist_ma250': 'N/A', 'ma250_comment': '数据不足',
            'resistance': 'N/A', 'resistance_comment': '数据不足',
        }

    df_120['ma120'] = df_120['close'].rolling(120).mean()
    df_120['ma250'] = df_120['close'].rolling(250).mean()

    stock_t1 = df_120[df_120['trade_date'] != t_date].iloc[-1] if len(df_120) > 1 else df_120.iloc[-1]
    close_t1 = float(stock_t1['close'])

    low_120 = float(df_120['low'].min())
    high_120 = float(df_120['high'].max())
    win_rate = round((close_t1 - low_120) / (high_120 - low_120) * 100, 1) if high_120 > low_120 else 50

    if win_rate < 20:
        wr_comment = '极度低位套牢区'
    elif win_rate < 50:
        wr_comment = '低位区域'
    elif win_rate < 80:
        wr_comment = '中高位置'
    else:
        wr_comment = '高位获利区'

    ma120_val = float(stock_t1['ma120']) if pd.notna(stock_t1['ma120']) else None
    ma250_val = float(stock_t1['ma250']) if pd.notna(stock_t1['ma250']) else None

    dist_ma120 = round((close_t1 - ma120_val) / ma120_val * 100, 2) if ma120_val and ma120_val > 0 else None
    dist_ma250 = round((close_t1 - ma250_val) / ma250_val * 100, 2) if ma250_val and ma250_val > 0 else None

    ma120_cmt = f'股价在半年线{"上方" if dist_ma120 and dist_ma120 > 0 else "下方"}' if dist_ma120 is not None else '数据不足'
    ma250_cmt = f'股价在年线{"上方" if dist_ma250 and dist_ma250 > 0 else "下方"}' if dist_ma250 is not None else '数据不足'

    if dist_ma120 and dist_ma120 < -10:
        resistance = '相对低位'
        res_comment = '下方有支撑，上方有空间'
    elif dist_ma120 and dist_ma120 > 10:
        resistance = '相对高位'
        res_comment = '上方有压力，注意回撤'
    else:
        resistance = '中间位置'
        res_comment = '上下均有空间'

    return {
        'win_rate': f'{win_rate:.1f}%',
        'win_rate_comment': wr_comment,
        'dist_ma120': f'{dist_ma120:+.2f}%' if dist_ma120 is not None else 'N/A',
        'ma120_comment': ma120_cmt,
        'dist_ma250': f'{dist_ma250:+.2f}%' if dist_ma250 is not None else 'N/A',
        'ma250_comment': ma250_cmt,
        'resistance': resistance,
        'resistance_comment': res_comment,
    }


def calc_dim4_market(t_date):
    """维度四：情绪周期"""
    try:
        limit_up = call_api("limit_list_d", {"trade_date": t_date, "limit_type": "U"})
        limit_down = call_api("limit_list_d", {"trade_date": t_date, "limit_type": "D"})
        lu = len(limit_up.get('ts_code', [])) if limit_up else 0
        ld = len(limit_down.get('ts_code', [])) if limit_down else 0
    except:
        lu, ld = 0, 0

    try:
        idx = call_api("index_daily", {"ts_code": "000300.SH", "start_date": t_date, "end_date": t_date})
        if idx and 'pct_chg' in idx and idx['pct_chg']:
            hs300_pct = round(float(idx['pct_chg'][0]), 2)
        else:
            hs300_pct = 0.0
    except:
        hs300_pct = 0.0

    if lu >= 50 and ld < 10:
        sentiment = '亢奋'
        sentiment_comment = '市场做多情绪高涨'
    elif ld > 30 or lu < 5:
        sentiment = '退潮'
        sentiment_comment = '市场情绪低迷'
    else:
        sentiment = '中性'
        sentiment_comment = '市场平稳'

    return {
        'limit_up': lu,
        'limit_down': ld,
        'sentiment': sentiment,
        'sentiment_comment': sentiment_comment,
        'hs300_pct': f'{hs300_pct:+.2f}%',
    }


def calc_dim5_seat(ts_code, t_date):
    """维度五：资金席位"""
    month_start = t_date[:6] + '01'

    try:
        margin = call_api("margin_detail", {"ts_code": ts_code, "start_date": month_start, "end_date": t_date})
        if margin and 'trade_date' in margin and len(margin['trade_date']) >= 2:
            m_df = pd.DataFrame(margin)
            first_bal = float(m_df.iloc[0]['rzye'])
            last_bal = float(m_df.iloc[-1]['rzye'])
            change = round((last_bal - first_bal) / first_bal * 100, 2) if first_bal > 0 else 0
            balance = round(last_bal / 1e8, 2)
            margin_comment = '杠杆资金小幅加仓' if change > 0 else ('小幅减仓' if change < 0 else '持平')
        else:
            balance, change, margin_comment = 0, 0, '数据不足'
    except:
        balance, change, margin_comment = 0, 0, '数据不足'

    try:
        block = call_api("block_trade", {"ts_code": ts_code, "start_date": month_start, "end_date": t_date})
        block_count = len(block.get('trade_date', [])) if block else 0
        block_trade = f'近30日{block_count}笔' if block_count > 0 else '无'
    except:
        block_trade = '无'

    return {
        'margin_balance': f'{balance}亿元' if balance > 0 else 'N/A',
        'margin_change': f'{change:+.2f}%' if change != 0 else 'N/A',
        'margin_comment': margin_comment,
        'block_trade': block_trade,
    }


def calc_attribution(ts_code, t_date, stock_df):
    """计算5维度归因"""
    dim1 = calc_dim1_sector(ts_code, t_date, stock_df)
    dim2 = calc_dim2_auction(t_date, stock_df)
    dim3 = calc_dim3_chip(ts_code, t_date, stock_df)
    dim4 = calc_dim4_market(t_date)
    dim5 = calc_dim5_seat(ts_code, t_date)
    return dim1, dim2, dim3, dim4, dim5


if __name__ == '__main__':
    import json, sys
    sys.path.insert(0, 'f:/daogu_chacha/server')
    print(json.dumps({'status': 'ok'}))
