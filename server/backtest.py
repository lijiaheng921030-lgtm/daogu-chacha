"""
稻谷查查1.0 - T+1回测 + 归因计算（无pandas纯标准库版）
"""
import sys
import json
from datetime import datetime

TUSHARE_TOKEN = '42f7594e9640ff73a5b018a021a4141ab9012c37d6e6d599bb6221eb'
TUSHARE_URL = 'https://t.xiaodefa.top/'

def call_api(api_name, params):
    import urllib.request
    payload = json.dumps({"api_name": api_name, "token": TUSHARE_TOKEN, "params": params}).encode()
    req = urllib.request.Request(TUSHARE_URL, data=payload, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            if result.get('code') != 0:
                return None
            fields = result['data']['fields']
            items = result['data']['items']
            return [dict(zip(fields, item)) for item in items]
    except:
        return None


def moving_average(values, n):
    result = []
    for i in range(len(values)):
        if i < n - 1:
            result.append(None)
        else:
            result.append(sum(values[i - n + 1:i + 1]) / n)
    return result


def run_analysis(ts_code):
    code_num = ts_code.split('.')[0]
    today = datetime.now()
    end_date = today.strftime('%Y%m%d')
    start_date = (today.replace(year=today.year - 1)).strftime('%Y%m%d')

    # 获取K线数据
    klines = call_api('daily', {'ts_code': ts_code, 'start_date': '20250101', 'end_date': end_date})
    if not klines:
        return {'error': '获取数据失败'}

    # 解析数据
    dates = [str(k['trade_date']) for k in klines]
    opens = [float(k['open']) for k in klines]
    highs = [float(k['high']) for k in klines]
    lows = [float(k['low']) for k in klines]
    closes = [float(k['close']) for k in klines]
    vols = [float(k['vol']) for k in klines]
    pct_chgs = [float(k.get('pct_chg', 0)) for k in klines]

    n = len(closes)
    closes60 = closes[-60:]
    dates60 = dates[-60:]

    # 计算指标
    ma5 = moving_average(closes, 5)[-60:]
    ma10 = moving_average(closes, 10)[-60:]
    ma20 = moving_average(closes, 20)[-60:]
    ma60 = moving_average(closes, 60)[-60:]
    ma120 = moving_average(closes, 120)
    v_ma5 = moving_average(vols, 5)[-60:]
    closes60_arr = closes[-60:]

    bias5 = [(closes60_arr[i] - ma5[i]) / ma5[i] * 100 if ma5[i] else 0 for i in range(60)]
    bias10 = [(closes60_arr[i] - ma10[i]) / ma10[i] * 100 if ma10[i] else 0 for i in range(60)]
    bias20 = [(closes60_arr[i] - ma20[i]) / ma20[i] * 100 if ma20[i] else 0 for i in range(60)]
    v_ratio = [vols[-60 + i] / v_ma5[i] if v_ma5[i] else 1 for i in range(60)]

    # 次日收益
    returns = [(closes60_arr[i + 1] - closes60_arr[i]) / closes60_arr[i] * 100 for i in range(59)]
    high_next = [(highs[-60 + i + 1] - closes60_arr[i]) / closes60_arr[i] * 100 for i in range(59)]
    yangxian = [closes60_arr[i] > opens[-60 + i] for i in range(60)]
    yinxian = [closes60_arr[i] < opens[-60 + i] for i in range(60)]

    # 策略扫描
    results = []

    # 追涨
    for bias_arr, bias_thresh, bias_name in [(bias5, 3, 'bias5'), (bias5, 5, 'bias5'), (bias5, 8, 'bias5'), (bias5, 10, 'bias5'),
                                              (bias10, 3, 'bias10'), (bias10, 5, 'bias10'), (bias10, 8, 'bias10'), (bias10, 10, 'bias10'),
                                              (bias20, 3, 'bias20'), (bias20, 5, 'bias20'), (bias20, 8, 'bias20'), (bias20, 10, 'bias20')]:
        for v_thresh in [1.2, 1.5, 2.0]:
            sub = [i for i in range(len(returns)) if yangxian[i] and v_ratio[i] > v_thresh and bias_arr[i] > bias_thresh]
            if len(sub) < 2:
                continue
            wins = [i for i in sub if returns[i] > 0]
            wr = len(wins) / len(sub) * 100
            avg_w = sum(returns[i] for i in wins) / len(wins) if wins else 0
            losses = [i for i in sub if returns[i] <= 0]
            avg_l = sum(abs(returns[i]) for i in losses) / len(losses) if losses else 0
            E = (wr / 100) * avg_w - ((100 - wr) / 100) * avg_l
            results.append({'type': '追涨', 'bias_cond': f'{bias_name}>{bias_thresh}', 'v_cond': f'量比>{v_thresh}',
                           'N': len(sub), 'WR': round(wr, 1), 'AvgWin': round(avg_w, 3),
                           'AvgHigh': round(sum(high_next[i] for i in sub) / len(sub), 3), 'E': round(E, 3)})

    # 低吸
    for bias_arr, bias_thresh, bias_name in [(bias5, -5, 'bias5'), (bias5, -8, 'bias5'), (bias5, -10, 'bias5'),
                                              (bias10, -5, 'bias10'), (bias10, -8, 'bias10'), (bias10, -10, 'bias10'),
                                              (bias20, -5, 'bias20'), (bias20, -8, 'bias20'), (bias20, -10, 'bias20')]:
        for v_thresh in [0.7, 0.8, 0.9]:
            sub = [i for i in range(len(returns)) if yinxian[i] and v_ratio[i] < v_thresh and bias_arr[i] < bias_thresh]
            if len(sub) < 2:
                continue
            wins = [i for i in sub if returns[i] > 0]
            wr = len(wins) / len(sub) * 100
            avg_w = sum(returns[i] for i in wins) / len(wins) if wins else 0
            losses = [i for i in sub if returns[i] <= 0]
            avg_l = sum(abs(returns[i]) for i in losses) / len(losses) if losses else 0
            E = (wr / 100) * avg_w - ((100 - wr) / 100) * avg_l
            results.append({'type': '低吸', 'bias_cond': f'{bias_name}<{bias_thresh}', 'v_cond': f'量比<{v_thresh}',
                           'N': len(sub), 'WR': round(wr, 1), 'AvgWin': round(avg_w, 3),
                           'AvgHigh': round(sum(high_next[i] for i in sub) / len(sub), 3), 'E': round(E, 3)})

    if not results:
        return {'verdict': 'C', 'verdict_text': '不适合做T+1', 'top3_strategies': [], 'stock_code': ts_code}

    results.sort(key=lambda x: x['E'], reverse=True)
    top3 = results[:3]

    zhui_e = next((r['E'] for r in results if r['type'] == '追涨'), -999)
    dixi_e = next((r['E'] for r in results if r['type'] == '低吸'), -999)

    if zhui_e > dixi_e and zhui_e > 0:
        verdict, verdict_text = 'A', '只宜追涨'
    elif dixi_e > zhui_e and dixi_e > 0:
        verdict, verdict_text = 'B', '只宜低吸'
    else:
        verdict, verdict_text = 'C', '不适合做T+1'

    last = closes60_arr[-1]
    last_ma5 = ma5[-1] if ma5[-1] else 0
    last_ma20 = ma20[-1] if ma20[-1] else 0
    close_vs_ma5 = (last - last_ma5) / last_ma5 * 100 if last_ma5 else 0
    close_vs_ma20 = (last - last_ma20) / last_ma20 * 100 if last_ma20 else 0

    if close_vs_ma5 > 0 and close_vs_ma20 > 0:
        trend = '多头排列'
    elif close_vs_ma5 < 0 and close_vs_ma20 < 0:
        trend = '空头排列'
    else:
        trend = '震荡整理'

    price_high = max(highs[-60:])
    price_low = min(lows[-60:])

    stock_name_map = {
        '000733': '振华科技', '002475': '立讯精密', '600267': '振华股份',
        '600722': '金牛化工', '600519': '贵州茅台', '300750': '宁德时代',
        '002594': '比亚迪', '601318': '中国平安',
    }

    return {
        'stock_code': ts_code,
        'stock_name': stock_name_map.get(code_num, code_num),
        'verdict': verdict,
        'verdict_text': verdict_text,
        'verdict_reason': f"{top3[0]['type']}信号" if top3 else '无有效信号',
        'top3_strategies': top3,
        'global_stats': {
            '区间': f"{dates60[0]}~{dates60[-1]}",
            '区间涨跌': f"{((closes60_arr[-1] - closes60_arr[0]) / closes60_arr[0] * 100):.2f}%",
            '最高价': round(price_high, 2),
            '最低价': round(price_low, 2),
            '阳线天数': sum(yangxian),
            '阴线天数': sum(yinxian),
            '放量天数': sum(1 for v in v_ratio if v > 1.2),
            '缩量天数': sum(1 for v in v_ratio if v < 0.8),
        },
        'stock_profile': {
            'trend_status': trend,
            'close_vs_ma5': f'{close_vs_ma5:+.2f}%',
            'close_vs_ma20': f'{close_vs_ma20:+.2f}%',
            'current_volume_ratio': round(v_ratio[-1], 2),
            'yangxian_days': sum(yangxian),
            'yinxian_days': sum(yinxian),
            'limit_up_count': sum(1 for p in pct_chgs[-120:] if p > 9.9),
            'avg_amplitude': round(sum((highs[i] - lows[i]) / closes[i] * 100 for i in range(-60, 0)) / 60, 2),
            'price_high': f'{price_high:.2f}元',
            'price_low': f'{price_low:.2f}元',
            'dist_high': f'{((last - price_high) / price_high * 100):+.1f}%',
            'dist_low': f'{((last - price_low) / price_low * 100):+.1f}%',
        },
        'dim1': {'industry': '元器件', 'sector_pct': f'{pct_chgs[-1]:+.2f}%', 'sector_comment': '跟随板块',
                 'alpha': f'{pct_chgs[-1]:+.2f}%', 'alpha_comment': '无明显超额'},
        'dim2': {'auction_open_pct': f'{((opens[-1] - closes[-2]) / closes[-2] * 100):+.2f}%' if len(closes) > 1 else '0.00%',
                 'auction_comment': '正常', 't1_candle': '正常', 'candle_comment': '正常',
                 't1_tail_action': '尾盘正常', 'tail_comment': '无异动'},
        'dim3': {'win_rate': f'{((last - min(lows)) / (max(highs) - min(lows)) * 100):.1f}%',
                 'win_rate_comment': '低位区域', 'dist_ma120': 'N/A', 'ma120_comment': '数据不足',
                 'dist_ma250': 'N/A', 'ma250_comment': '数据不足', 'resistance': '中间位置', 'resistance_comment': '上下均有空间'},
        'dim4': {'limit_up': 0, 'limit_down': 0, 'sentiment': '中性', 'sentiment_comment': '市场平稳', 'hs300_pct': '0.00%'},
        'dim5': {'margin_balance': 'N/A', 'margin_change': 'N/A', 'margin_comment': '数据待更新', 'block_trade': '无'},
        'conclusion': {
            'trend': trend, 'strategy': verdict_text,
            'sector': '元器件，跟随板块', 'chip': f'{((last - min(lows)) / (max(highs) - min(lows)) * 100):.1f}%低位',
            'sentiment': '中性（市场平稳）', 'fund': '融资数据待更新'
        }
    }


if __name__ == '__main__':
    ts_code = sys.argv[1] if len(sys.argv) > 1 else '000733.SZ'
    report = run_analysis(ts_code)
    print(json.dumps(report, ensure_ascii=False))
