"""采集器基类"""
import json
import requests
from datetime import datetime, timezone, timedelta
from config.settings import USER_AGENT

TZ_CST = timezone(timedelta(hours=8))


class BaseCollector:
    name = "base"

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})

    def now(self):
        return datetime.now(TZ_CST)

    def now_iso(self):
        return self.now().isoformat()

    def today_str(self):
        return self.now().strftime('%Y-%m-%d')

    def fetch(self, url, **kwargs):
        kwargs.setdefault("timeout", 20)
        return self.session.get(url, **kwargs)

    def post(self, url, **kwargs):
        kwargs.setdefault("timeout", 20)
        return self.session.post(url, **kwargs)

    def collect(self):
        """子类实现，返回 [(metric, value, unit, confidence, raw_dict), ...]"""
        raise NotImplementedError

    def save(self, conn, records):
        ts = self.now_iso()
        for metric, value, unit, confidence, raw in records:
            conn.execute(
                "INSERT INTO crowd_data (ts, source, metric, value, unit, confidence, raw_json) VALUES (?,?,?,?,?,?,?)",
                (ts, self.name, metric, value, unit, confidence, json.dumps(raw, ensure_ascii=False) if raw else None)
            )
        conn.commit()
        return len(records)
