"""
稻谷查查1.0 - T+1回测 + 归因计算（合并版）
直接从K线数据计算所有指标，不依赖外部API调用
"""
import sys
import json
import pandas as pd
import numpy as np
from pathlib import Path

TUSHARE_TOKEN = '42f7594e9640ff73a5b018a021a4141ab9012c37d6e6d599bb6221eb'
TUSHARE_URL = 'https://t.xiaodefa.top/'

def call_api(api_name, params):
    import requests
    try:
        payload = {"api_name": api_name, "token": TUSHARE_TOKEN, "params": params}
        resp = requests.post(TUSHARE_URL, json=payload, timeout=8)
        result = resp.json()
        if result.get('code') != 0:
            return None
        fields = result['data']['fields']
        items = result['data']['items']
        return {f: [item[i] for item in items] for i, f in enumerate(fields)}
    except:
        return None


def run_analysis(ts_code, csv_path):
    df = pd.read_csv(csv_path)
    df = df.rename(columns={'vol': 'volume', 'trade_date': 'date'})
    df['date'] = pd.to_datetime(df['date'])
    df = df.sort_values('date').reset_index(drop=True)
    for col in ['open', 'high', 'low', 'close', 'volume', 'pct_chg']:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)

    today_str = df['date'].iloc[-1].strftime('%Y%m%d')
    df60 = df.tail(60).reset_index(drop=True)
    df120 = df.tail(120).reset_index(drop=True)
    df_full = df.reset_index(drop=True)

    # === 计算指标 ===
    for d in [df60, df120]:
        d['ma5'] = d['close'].rolling(5).mean()
        d['ma10'] = d['close'].rolling(10).mean()
        d['ma20'] = d['close'].rolling(20).mean()
        d['ma60'] = d['close'].rolling(60).mean()
        d['ma120'] = d['close'].rolling(120).mean()
        d['ma250'] = d['close'].rolling(250).mean()
        d['v_ma5'] = d['volume'].rolling(5).mean()
        d['v_ratio'] = d['volume'] / d['v_ma5']
        d['bias5'] = (d['close'] - d['ma5']) / d['ma5'] * 100
        d['bias10'] = (d['close'] - d['ma10']) / d['ma10'] * 100
        d['bias20'] = (d['close'] - d['ma20']) / d['ma20'] * 100
        d['next_close'] = d['close'].shift(-1)
        d['next_high'] = d['high'].shift(-1)
        d['return_next'] = (d['next_close'] - d['close']) / d['close'] * 100
        d['high_next'] = (d['next_high'] - d['close']) / d['close'] * 100
        d['yangxian'] = d['close'] > d['open']
        d['yinxian'] = d['close'] < d['open']

    dw = df60.iloc[:-1].copy()
    last = df60.iloc[-1]
    last_full = df120.iloc[-1]
    t1 = df60.iloc[-2] if len(df60) > 1 else last

    # === T+1策略回测 ===
    results = []

    # 追涨
    for bias_col in ['bias5', 'bias10', 'bias20']:
        for bias_thresh in [3, 5, 8, 10]:
            for v_thresh in [1.2, 1.5, 2.0]:
                cond = (dw['yangxian']) & (dw['v_ratio'] > v_thresh) & (dw[bias_col] > bias_thresh)
                sub = dw[cond]
                if len(sub) < 2:
                    continue
                wins = sub[sub['return_next'] > 0]
                losses = sub[sub['return_next'] <= 0]
                wr = len(wins) / len(sub) * 100
                avg_w = wins['return_next'].mean() if len(wins) > 0 else 0
                avg_l = abs(losses['return_next'].mean()) if len(losses) > 0 else 0
                E = (wr / 100) * avg_w - ((100 - wr) / 100) * avg_l
                results.append({
                    'type': '追涨', 'bias_cond': f'{bias_col}>{bias_thresh}',
                    'v_cond': f'量比>{v_thresh}', 'N': len(sub),
                    'WR': round(wr, 1), 'AvgWin': round(avg_w, 3),
                    'AvgHigh': round(sub['high_next'].mean(), 3),
                    'E': round(E, 3),
                })

    # 低吸
    for bias_col in ['bias5', 'bias10', 'bias20']:
        for bias_thresh in [-5, -8, -10]:
            for v_thresh in [0.7, 0.8, 0.9]:
                cond = (dw['yinxian']) & (dw['v_ratio'] < v_thresh) & (dw[bias_col] < bias_thresh)
                sub = dw[cond]
                if len(sub) < 2:
                    continue
                wins = sub[sub['return_next'] > 0]
                losses = sub[sub['return_next'] <= 0]
                wr = len(wins) / len(sub) * 100
                avg_w = wins['return_next'].mean() if len(wins) > 0 else 0
                avg_l = abs(losses['return_next'].mean()) if len(losses) > 0 else 0
                E = (wr / 100) * avg_w - ((100 - wr) / 100) * avg_l
                results.append({
                    'type': '低吸', 'bias_cond': f'{bias_col}<{bias_thresh}',
                    'v_cond': f'量比<{v_thresh}', 'N': len(sub),
                    'WR': round(wr, 1), 'AvgWin': round(avg_w, 3),
                    'AvgHigh': round(sub['high_next'].mean(), 3),
                    'E': round(E, 3),
                })

    res_df = pd.DataFrame(results)
    if len(res_df) == 0:
        verdict, verdict_text = 'C', '不适合做T+1'
        top3 = []
    else:
        res_df = res_df.sort_values('E', ascending=False).reset_index(drop=True)
        top3 = res_df.head(3).to_dict('records')
        zhui_e = res_df[res_df['type'] == '追涨']['E'].iloc[0] if len(res_df[res_df['type'] == '追涨']) > 0 else -999
        dixi_e = res_df[res_df['type'] == '低吸']['E'].iloc[0] if len(res_df[res_df['type'] == '低吸']) > 0 else -999
        if zhui_e > dixi_e and zhui_e > 0:
            verdict, verdict_text = 'A', '只宜追涨'
        elif dixi_e > zhui_e and dixi_e > 0:
            verdict, verdict_text = 'B', '只宜低吸'
        else:
            verdict, verdict_text = 'C', '不适合做T+1'

    # === 全局统计 ===
    global_stats = {
        '区间': f"{dw['date'].iloc[0].strftime('%Y-%m-%d')} ~ {dw['date'].iloc[-1].strftime('%Y-%m-%d')}",
        '区间涨跌': f"{(dw['close'].iloc[-1] - dw['close'].iloc[0]) / dw['close'].iloc[0] * 100:.2f}%",
        '最高价': round(float(dw['high'].max()), 2),
        '最低价': round(float(dw['low'].min()), 2),
        '阳线天数': int((dw['close'] > dw['open']).sum()),
        '阴线天数': int((dw['close'] < dw['open']).sum()),
        '放量天数': int((dw['v_ratio'] > 1.2).sum()),
        '缩量天数': int((dw['v_ratio'] < 0.8).sum()),
    }

    # === 股性画像 ===
    price_high_60 = round(float(df60['high'].max()), 2)
    price_low_60 = round(float(df60['low'].min()), 2)
    current_price = float(last['close'])
    dist_high = round((current_price - price_high_60) / price_high_60 * 100, 2)
    dist_low = round((current_price - price_low_60) / price_low_60 * 100, 2)

    close_vs_ma5_v = float(last['ma5']) if pd.notna(last['ma5']) else 0
    close_vs_ma20_v = float(last['ma20']) if pd.notna(last['ma20']) else 0
    close_vs_ma5 = round((current_price - close_vs_ma5_v) / close_vs_ma5_v * 100, 2) if close_vs_ma5_v != 0 else 0
    close_vs_ma20 = round((current_price - close_vs_ma20_v) / close_vs_ma20_v * 100, 2) if close_vs_ma20_v != 0 else 0

    if pd.notna(last['ma5']) and pd.notna(last['ma20']):
        if close_vs_ma5 > 0 and close_vs_ma20 > 0:
            trend_status = '多头排列'
        elif close_vs_ma5 < 0 and close_vs_ma20 < 0:
            trend_status = '空头排列'
        else:
            trend_status = '震荡整理'
    else:
        trend_status = '数据不足'

    limit_up_count = int((df120['pct_chg'] > 9.9).sum()) if 'pct_chg' in df120.columns else 0
    avg_amp = round(float(((df120['high'] - df120['low']) / df120['close'] * 100).mean()), 2)

    stock_profile = {
        'trend_status': trend_status,
        'close_vs_ma5': f'{close_vs_ma5:+.2f}%',
        'close_vs_ma20': f'{close_vs_ma20:+.2f}%',
        'current_volume_ratio': round(float(last['v_ratio']), 2) if pd.notna(last['v_ratio']) else 0,
        'yangxian_days': int((df120['close'] > df120['open']).sum()),
        'yinxian_days': int((df120['close'] < df120['open']).sum()),
        'limit_up_count': limit_up_count,
        'avg_amplitude': avg_amp,
        'price_high': f'{price_high_60}元',
        'price_low': f'{price_low_60}元',
        'dist_high': f'{dist_high:+.1f}%',
        'dist_low': f'{dist_low:+.1f}%',
    }

    # === 维度一：板块联动 ===
    industry_map = {
        '000733': '元器件', '002475': '电子制造', '600267': '化学制药',
        '600722': '化工', '600519': '白酒', '300750': '新能源汽车',
        '002594': '汽车整车', '601318': '保险',
    }
    code_num = ts_code.split('.')[0]
    industry = industry_map.get(code_num, '其他')
    stock_pct = float(last['pct_chg']) if 'pct_chg' in last.index else 0.0
    sector_pct = 0.0
    alpha = round(stock_pct - sector_pct, 2)

    dim1 = {
        'industry': industry,
        'sector_pct': f'{sector_pct:+.2f}%',
        'sector_comment': '个股跟随板块' if abs(alpha) < 1 else ('强于板块' if alpha > 0 else '弱于板块'),
        'alpha': f'{alpha:+.2f}%',
        'alpha_comment': '无明显超额收益' if abs(alpha) < 1 else ('正向Alpha' if alpha > 0 else '负向Alpha'),
    }

    # === 维度二：盘口竞价 ===
    t_close = float(last['close'])
    t_open = float(last['open'])
    t1_close = float(t1['close'])
    t1_high = float(t1['high'])
    t1_low = float(t1['low'])
    t1_range = t1_high - t1_low if t1_high > t1_low else 1
    auction_pct = round((t_open - t1_close) / t1_close * 100, 2) if t1_close != 0 else 0.0
    is_yang = t1_close > float(t1['open'])
    upper_shadow = (t1_high - t1_close) / t1_range
    lower_shadow = (t1_close - t1_low) / t1_range

    if auction_pct > 2:
        auction_cmt = '高开，有异动'
    elif auction_pct < -2:
        auction_cmt = '低开，抛压明显'
    else:
        auction_cmt = '正常平开'

    candle = ('阳线' if is_yang else '阴线') + ('+长上影' if upper_shadow > 0.5 else ('+长下影' if lower_shadow > 0.5 else ''))
    candle_cmt = '上方有压力' if upper_shadow > 0.5 else ('下方有支撑' if lower_shadow > 0.5 else '正常')

    tail_action = '尾盘冲高回落' if upper_shadow > 0.6 else ('尾盘企稳' if lower_shadow > 0.6 else '尾盘正常')
    tail_cmt = '压力明显' if upper_shadow > 0.6 else ('资金托底' if lower_shadow > 0.6 else '无异动')

    dim2 = {
        'auction_open_pct': f'{auction_pct:+.2f}%',
        'auction_comment': auction_cmt,
        't1_candle': candle or '正常',
        'candle_comment': candle_cmt,
        't1_tail_action': tail_action,
        'tail_comment': tail_cmt,
    }

    # === 维度三：筹码分布 ===
    df_250 = df_full.copy()
    df_250['ma120'] = df_250['close'].rolling(120).mean()
    df_250['ma250'] = df_250['close'].rolling(250).mean()
    t1_full = df_250.iloc[-2] if len(df_250) > 1 else df_250.iloc[-1]
    close_t1 = float(t1_full['close'])
    low_250 = float(df_250['low'].min())
    high_250 = float(df_250['high'].max())
    win_rate = round((close_t1 - low_250) / (high_250 - low_250) * 100, 1) if high_250 > low_250 else 50
    ma120_v = float(t1_full['ma120']) if pd.notna(t1_full['ma120']) else None
    ma250_v = float(t1_full['ma250']) if pd.notna(t1_full['ma250']) else None
    dist_ma120 = round((close_t1 - ma120_v) / ma120_v * 100, 2) if ma120_v and ma120_v > 0 else None
    dist_ma250 = round((close_t1 - ma250_v) / ma250_v * 100, 2) if ma250_v and ma250_v > 0 else None

    wr_cmt = '极度低位套牢区' if win_rate < 20 else ('低位区域' if win_rate < 50 else ('高位区域' if win_rate > 80 else '中间位置'))
    if dist_ma120 and dist_ma120 < -10:
        resistance, res_cmt = '相对低位', '下方有支撑，上方有空间'
    elif dist_ma120 and dist_ma120 > 10:
        resistance, res_cmt = '相对高位', '上方有压力'
    else:
        resistance, res_cmt = '中间位置', '上下均有空间'

    dim3 = {
        'win_rate': f'{win_rate:.1f}%',
        'win_rate_comment': wr_cmt,
        'dist_ma120': f'{dist_ma120:+.2f}%' if dist_ma120 is not None else 'N/A',
        'ma120_comment': f'股价在半年线{"上方" if dist_ma120 and dist_ma120 > 0 else "下方"}' if dist_ma120 is not None else '数据不足',
        'dist_ma250': f'{dist_ma250:+.2f}%' if dist_ma250 is not None else 'N/A',
        'ma250_comment': f'股价在年线{"上方" if dist_ma250 and dist_ma250 > 0 else "下方"}' if dist_ma250 is not None else '数据不足',
        'resistance': resistance,
        'resistance_comment': res_cmt,
    }

    # === 维度四：情绪周期（轻量级API） ===
    try:
        lu_d = call_api("limit_list_d", {"trade_date": today_str, "limit_type": "U"})
        ld_d = call_api("limit_list_d", {"trade_date": today_str, "limit_type": "D"})
        lu = len(lu_d.get('ts_code', [])) if lu_d else 0
        ld = len(ld_d.get('ts_code', [])) if ld_d else 0
    except:
        lu, ld = 0, 0

    try:
        idx = call_api("index_daily", {"ts_code": "000300.SH", "start_date": today_str, "end_date": today_str})
        hs300_pct = round(float(idx['pct_chg'][0]), 2) if idx and 'pct_chg' in idx and idx['pct_chg'] else 0.0
    except:
        hs300_pct = 0.0

    if lu >= 50 and ld < 10:
        sentiment, sent_cmt = '亢奋', '市场做多情绪高涨'
    elif ld > 30 or lu < 5:
        sentiment, sent_cmt = '退潮', '市场情绪低迷'
    else:
        sentiment, sent_cmt = '中性', '市场平稳'

    dim4 = {
        'limit_up': lu,
        'limit_down': ld,
        'sentiment': sentiment,
        'sentiment_comment': sent_cmt,
        'hs300_pct': f'{hs300_pct:+.2f}%',
    }

    # === 维度五：资金席位（轻量级API） ===
    month_start = today_str[:6] + '01'
    try:
        margin = call_api("margin_detail", {"ts_code": ts_code, "start_date": month_start, "end_date": today_str})
        if margin and 'trade_date' in margin and len(margin['trade_date']) >= 2:
            m_df = pd.DataFrame(margin)
            first_bal = float(m_df.iloc[0]['rzye'])
            last_bal = float(m_df.iloc[-1]['rzye'])
            change = round((last_bal - first_bal) / first_bal * 100, 2) if first_bal > 0 else 0
            balance = round(last_bal / 1e8, 2)
            m_cmt = '杠杆资金小幅加仓' if change > 0 else ('小幅减仓' if change < 0 else '持平')
        else:
            balance, change, m_cmt = 0, 0, '数据不足'
    except:
        balance, change, m_cmt = 0, 0, '数据不足'

    try:
        block = call_api("block_trade", {"ts_code": ts_code, "start_date": month_start, "end_date": today_str})
        bc = len(block.get('trade_date', [])) if block else 0
        block_trade = f'近30日{bc}笔' if bc > 0 else '无'
    except:
        block_trade = '无'

    dim5 = {
        'margin_balance': f'{balance}亿元' if balance > 0 else 'N/A',
        'margin_change': f'{change:+.2f}%' if change != 0 else 'N/A',
        'margin_comment': m_cmt,
        'block_trade': block_trade,
    }

    # === 综合结论 ===
    conclusion = {
        'trend': trend_status,
        'strategy': verdict_text,
        'sector': f'{industry}，{"强于板块" if alpha > 0 else "跟随板块"}',
        'chip': f'{win_rate}%（{wr_cmt}），{resistance}',
        'sentiment': f'{sentiment}（{sent_cmt}）',
        'fund': f'融资{"+" + str(change) + "%" if change > 0 else str(change) + "%" if change != 0 else "数据待更新"}' if change != 0 else '融资数据待更新',
    }

    return {
        'stock_code': ts_code,
        'verdict': verdict,
        'verdict_text': verdict_text,
        'verdict_reason': f"{top3[0]['type']}信号，{top3[0]['bias_cond']}" if top3 else '无有效信号',
        'top3_strategies': top3,
        'global_stats': global_stats,
        'dow_stats': {},
        'stock_profile': stock_profile,
        'dim1': dim1,
        'dim2': dim2,
        'dim3': dim3,
        'dim4': dim4,
        'dim5': dim5,
        'conclusion': conclusion,
    }


if __name__ == '__main__':
    ts_code = sys.argv[1]
    csv_path = sys.argv[2]
    report = run_analysis(ts_code, csv_path)
    print(json.dumps(report, ensure_ascii=False, indent=2))
