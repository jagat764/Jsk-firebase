#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Firebase Checker - Flask Web UI (Render-ready)
- Configurable via browser (token, chat_id, workers, etc.)
- Live SSE log stream + stats
- Start / Pause / Resume / Stop controls
- Android-friendly Tailwind UI
- /health endpoint for cron-job.org keep-alive
"""

import json
import os
import re
import time
import random
import queue
import threading
import tempfile
import requests
import urllib3
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock, Event
from typing import Dict, Set
from collections import deque
from flask import Flask, render_template, request, jsonify, Response, stream_with_context

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

app = Flask(__name__)

# ============================================================
# OUTPUT DIR (env-driven; /tmp on Render, output/ locally)
# ============================================================
OUTPUT_DIR        = os.environ.get(
    "OUTPUT_DIR",
    os.path.join(tempfile.gettempdir(), "fb-checker-output")
)

INVALID_URLS_FILE = "invalid_format_urls.txt"
PRIVATE_URLS_FILE = "private_urls.txt"
VALID_URLS_FILE   = "valid_urls.txt"
EMPTY_URLS_FILE   = "empty_urls.txt"

IMPORT_FILES = [VALID_URLS_FILE, INVALID_URLS_FILE,
                PRIVATE_URLS_FILE, EMPTY_URLS_FILE]

_URL_RE = re.compile(r"^(https?://[^\s#]+)")

# Ensure output dir exists at import time
try:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
except Exception:
    pass


# ============================================================
# PROXY POOL
# ============================================================
PROXIES_RAW = """
ams.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
nyc.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
atl.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
msy.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
nrt.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
waw.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
den.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
lon.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
iad.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
dal.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
lax.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
tor.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
phx.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
chi.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
lin.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
bos.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
sin.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
lis.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
sto.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
clt.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
mad.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
fra.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
par.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
mia.socks.ipvanish.com:1080:caEVXGbA:QJACVaY5k
prox-al.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-abc.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-at.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-au.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-bbc.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-be.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-bg.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-br.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-ca.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-ch.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-cl.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-cr.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-de.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-dk.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-espus.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-fi.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-fox.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-hbus.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-hk.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-in.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-is.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-it.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-jp.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-kr.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-lt.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-lv.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-md.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-netflixuk.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-ng.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-nl.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-no.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-nz.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-ph.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-pl.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-pt.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-rs.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-se.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-sg.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-tr.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-tw.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-ua.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-ukl.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-ukman.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-usil.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-usla.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-usny.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-ustx.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-vn.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
prox-yttv.pointtoserver.com:10799:purevpn0s12208669:3aeskw14
"""

class ProxyPool:
    def __init__(self, proxies):
        self.proxies = proxies
        self.failed = set()
        self.lock = Lock()
    def get_random(self, exclude=None):
        with self.lock:
            avail = [p for p in self.proxies if p["https"] not in self.failed]
            if not avail:
                self.failed.clear()
                avail = list(self.proxies)
            if not avail:
                return None
            if exclude:
                f = [p for p in avail if p["https"] != exclude]
                if f: avail = f
            return random.choice(avail)
    def mark_failed(self, proxy):
        if not proxy: return
        with self.lock:
            self.failed.add(proxy["https"])
    def size(self): return len(self.proxies)
    def available(self):
        with self.lock:
            return len([p for p in self.proxies if p["https"] not in self.failed])

def parse_proxies(raw):
    out = []
    for line in raw.strip().splitlines():
        line = line.strip()
        if not line or line.startswith("#"): continue
        parts = line.split(":")
        if len(parts) != 4: continue
        host, port, user, pw = parts
        if "socks" in host.lower():
            url = "socks5h://{}:{}@{}:{}".format(user, pw, host, port)
        else:
            url = "http://{}:{}@{}:{}".format(user, pw, host, port)
        out.append({"http": url, "https": url})
    return out


# ============================================================
# WORD BANK
# ============================================================
INDIAN_NAMES = [
    "raj","raju","rahul","rohit","ramesh","suresh","mahesh","mukesh","ajay",
    "vijay","sanjay","anil","sunil","amit","sumit","ankit","arjun","karan",
    "kartik","kumar","krish","krishna","deepak","deepa","nitish","nitu",
    "neha","nisha","priya","pooja","puja","anjali","anamika","kavita",
    "sonam","shilpa","riya","rani","swati","ritu","pinky","bittu","chhotu",
    "abhi","abhishek","aditya","akash","akshay","alok","aman","amir","anand",
    "ankur","ansh","anu","anuj","arav","arnav","ashish","ashu","ayush",
    "babu","badal","banti","bharat","bhavesh","bhola","bipin","bittu",
    "chandan","chetan","chirag","danish","darshan","deep","dev","devansh",
    "dhruv","dinesh","divyansh","gaurav","gopal","govind","guddu","gulshan",
    "harish","harsh","harshit","hemant","hitesh","imran","irfan","ishan",
    "jatin","jay","jitendra","jitesh","kabir","kamal","kapil","kishan",
    "lalit","lucky","madhav","mahi","manish","mannu","mayank","mohit",
    "mohan","mukul","naveen","navin","nikhil","nilesh","om","omprakash",
    "pankaj","pawan","pintu","prabhu","pradeep","prakash","pranav","prasad",
    "prateek","pratik","praveen","prem","prince","pritam","priyansh",
    "raja","rajan","rakesh","ranjit","ranveer","ravi","ravindra","ritik",
    "ritesh","sachin","sagar","sahil","sameer","sandeep","santosh","sarvesh",
    "satish","shahid","shailesh","shakti","shankar","shashank","shivam",
    "shubham","siddharth","sohan","sonu","suman","suraj","sushil","tarun",
    "tejas","tushar","uday","umang","varun","vedant","vicky","vikas",
    "vikram","vinay","vineet","vipin","vishal","vivek","yash","yogesh",
    "zafar","zaid","zain",
]

SHORT_PREFIXES = [
    "fir","fa","fb","fc","fd","fe","ff","fg","fh","fi","fj","fk","fl","fm",
    "fn","fo","fp","fq","fr","fs","ft","fu","fv","fw","fx","fy","fz",
    "myapp","myapp1","myapp2","myapp3","myproject","myproject1","myproject2",
    "myproj","myproj1","myproj2","my",
    "app1","app2","app3","newapp","newapp1","newapp2",
    "test","test1","test2","test3","demo","demo1","demo2",
    "prod","prod1","prod2","dev","dev1","dev2","stage","staging",
    "sample","sample1","sample2","trial","trial1","trial2",
]

SUFFIX_WORDS = (
    [str(i) for i in range(1, 101)] +
    ["v{}".format(i) for i in range(1, 101)] +
    ["new","old","final","latest","updated","real","original","official",
     "main","primary","backup","test","demo","prod","dev","live",
     "2020","2021","2022","2023","2024","2025","2026","2027","2028",
     "jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec",
     "app","web","api","site","portal","core","hub","node","center"]
)

PANEL_WORDS = [
    "admin","panel","pannel","penal","customer","support","client","clients",
    "user","users","master","boss","king","queen","op","main","root","server",
    "web","webhook","app",
]
RTO_WORDS  = ["rto","challan","chalan","parivahan","sarathi","vahan","e-challan","echallan"]
BANK_WORDS = [
    "bank","sbi","sbi-bank","sbibank","sbi-online","sbi-yono","yono",
    "sbicard","sbi-card","sbi-life",
    "hdfc","hdfc-bank","hdfcbank","hdfc-online","hdfc-card","hdfc-life",
    "kotak","kotak-bank","kotakbank","kotak-online","kotak-mahindra",
    "pnb","pnb-bank","pnbbank","punjab-national-bank",
    "pm-kisan","pmkisan","pm-kishan","kisan","kishan",
    "pmjay","pm-jay","ayushman","ayushman-bharat",
    "pmay","pmay-g","pmay-u","pmfby","pmjjby","pmsby",
]
GOV_WORDS = ["pm-kisan","pmkisan","pm-kishan","kisan","kishan","pm-modi","pmmodi","modi"]

ALL_NAMES = INDIAN_NAMES
ALL_SHORT = SHORT_PREFIXES
ALL_THEME = PANEL_WORDS + RTO_WORDS + BANK_WORDS + GOV_WORDS
HEX_CHARS = "0123456789abcdef"


def make_pid_turbo():
    r = random.random(); rc = random.choice
    hx = "".join(rc(HEX_CHARS) for _ in range(5))
    if r < 0.20: return "{}-{}".format(rc(ALL_NAMES), hx)
    if r < 0.38: return "{}-{}".format(rc(ALL_THEME), hx)
    if r < 0.50: return "{}-{}-{}".format(rc(ALL_NAMES), rc(ALL_THEME), hx)
    if r < 0.58:
        a, b = random.sample(ALL_NAMES, 2)
        return "{}-{}-{}".format(a, b, rc(SUFFIX_WORDS))
    if r < 0.68: return "{}-{}".format(rc(ALL_THEME), rc(ALL_NAMES))
    if r < 0.76: return "{}-{}".format(rc(ALL_THEME), rc(ALL_THEME))
    if r < 0.84: return "{}{}".format(rc(ALL_THEME), rc(SUFFIX_WORDS))
    if r < 0.90: return "{}-{}".format(rc(ALL_NAMES), rc(SUFFIX_WORDS))
    if r < 0.95: return "{}-{}".format(rc(ALL_SHORT), hx)
    if r < 0.98: return "{}-{}".format(rc(ALL_SHORT), rc(SUFFIX_WORDS))
    return rc(ALL_NAMES + ALL_THEME)

def generate_random_url():
    return "https://{}-default-rtdb.firebaseio.com".format(make_pid_turbo())


# ============================================================
# HTTP / CHECK
# ============================================================
HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/122.0 Safari/537.36",
}

def _raw_get(endpoint, headers, proxy, timeout):
    try:
        r = requests.get(endpoint, timeout=timeout, proxies=proxy,
                         headers=headers, verify=False)
        return r, None
    except requests.exceptions.Timeout:
        return None, "timeout"
    except requests.exceptions.ProxyError:
        return None, "proxy_error"
    except requests.exceptions.ConnectionError:
        return None, "connection_error"
    except Exception as e:
        s = str(e)
        if "socks" in s.lower(): return None, "socks_unavailable"
        return None, "unknown"

def _do_request_shallow(url, proxy, cfg):
    endpoint = "{}/.json?shallow=true".format(url)
    return _raw_get(endpoint, HEADERS, proxy, cfg["timeout"])

def check_url_format(url, proxy_pool, cfg):
    result = {"url": url, "status": "unknown", "status_code": 0,
              "response_msg": ""}
    attempts = [None]
    if cfg["enable_proxies"] and proxy_pool and proxy_pool.size() > 0:
        used = set()
        for _ in range(cfg["max_proxy_retries"]):
            p = proxy_pool.get_random()
            if p and p["https"] not in used:
                used.add(p["https"]); attempts.append(p)

    last_err = None
    for proxy in attempts:
        r_s, err_s = _do_request_shallow(url, proxy, cfg)
        if err_s:
            last_err = err_s
            if proxy: proxy_pool.mark_failed(proxy)
            continue
        code = r_s.status_code
        result["status_code"] = code
        if code == 401:
            result["status"] = "private"
            result["response_msg"] = "PRIVATE - unauthorized (401)"
            return result
        if code in (403, 404):
            result["status"] = "ignored"
            result["response_msg"] = "IGNORED ({})".format(code)
            return result
        if code == 423:
            result["status"] = "deactivated"
            result["response_msg"] = "DEAD - locked (423)"
            return result
        if code != 200:
            result["status"] = "http_error"
            result["response_msg"] = "HTTP {}".format(code)
            return result
        try:
            data = r_s.json()
        except (json.JSONDecodeError, ValueError):
            result["status"] = "invalid_json"
            result["response_msg"] = "INVALID JSON"
            return result
        if isinstance(data, dict):
            if data:
                result["status"] = "valid_with_data"
                result["response_msg"] = "VALID - public with data"
            else:
                result["status"] = "valid_empty"
                result["response_msg"] = "EMPTY - public, no data"
        else:
            result["status"] = "invalid_format"
            result["response_msg"] = "INVALID - root is {}".format(type(data).__name__)
        return result

    result["status"] = "error"
    err_map = {
        "timeout": "ERR - timeout", "proxy_error": "ERR - proxy",
        "connection_error": "ERR - connection", "socks_unavailable": "ERR - socks",
        "rate_limited": "ERR - rate-limited", "unknown": "ERR - unknown",
    }
    result["response_msg"] = err_map.get(last_err or "unknown",
                                         "ERR - {}".format(last_err))
    return result


# ============================================================
# RUNNER STATE
# ============================================================
class RunnerState:
    def __init__(self):
        self.lock = Lock()
        self.pause_event = Event(); self.pause_event.set()
        self.stop_event = Event()
        self.state = "idle"          # idle | running | paused | stopping
        self.thread = None
        self.log_q = deque(maxlen=2000)
        self.log_seq = 0
        self.subscribers = []
        self.stats = {
            "valid": 0, "empty": 0, "invalid": 0,
            "private": 0, "deactivated": 0, "errors": 0,
            "processed": 0, "batch": 0, "skipped": 0,
            "speed": 0.0, "elapsed": 0.0, "tg_sent": 0, "tg_failed": 0,
        }
        self.cfg = {}
        self.started_at = 0

    def push_log(self, kind, text):
        with self.lock:
            self.log_seq += 1
            entry = {"seq": self.log_seq, "kind": kind,
                     "text": text, "ts": time.time()}
            self.log_q.append(entry)
            for q in list(self.subscribers):
                try: q.put_nowait(entry)
                except Exception: pass

    def add_subscriber(self):
        q = queue.Queue(maxsize=2000)
        with self.lock:
            self.subscribers.append(q)
        return q

    def remove_subscriber(self, q):
        with self.lock:
            if q in self.subscribers:
                self.subscribers.remove(q)

    def snapshot(self):
        with self.lock:
            return dict(self.stats), self.state

    def set_state(self, s):
        with self.lock:
            self.state = s

    def get_state(self):
        with self.lock:
            return self.state

    def request_pause(self):
        with self.lock:
            if self.state != "running": return False
            self.state = "paused"
            self.pause_event.clear()
            return True

    def request_resume(self):
        with self.lock:
            if self.state != "paused": return False
            self.state = "running"
            self.pause_event.set()
            return True

    def request_stop(self):
        with self.lock:
            if self.state in ("idle", "stopping"): return False
            self.state = "stopping"
            self.pause_event.set()
            self.stop_event.set()
            return True

    def wait_if_paused(self):
        while not self.stop_event.is_set():
            if self.pause_event.wait(timeout=0.25):
                return


RUNNER = RunnerState()


# ============================================================
# TELEGRAM ALERTER
# ============================================================
def _html_escape(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

class TelegramAlerter:
    def __init__(self, token, chat_id, max_retries=5, base_delay=2.0):
        self.token = token; self.chat_id = chat_id
        self.max_retries = max_retries; self.base_delay = base_delay
        self.enabled = bool(token and chat_id)
        self._q = queue.Queue(); self._stop = Event(); self._thread = None
        self.sent = 0; self.failed = 0
        self._lock = Lock()

    def start(self):
        if not self.enabled: return
        self._thread = threading.Thread(target=self._worker, daemon=True)
        self._thread.start()

    def stop(self, drain_timeout=30.0):
        if not self.enabled: return
        self._stop.set()
        if self._thread: self._thread.join(timeout=drain_timeout)

    def enqueue(self, text):
        if not self.enabled: return
        self._q.put(text)

    def _worker(self):
        while not self._stop.is_set() or not self._q.empty():
            try: text = self._q.get(timeout=0.5)
            except queue.Empty: continue
            self._send_with_retry(text)

    def _post(self, text):
        url = "https://api.telegram.org/bot{}/sendMessage".format(self.token)
        payload = {"chat_id": self.chat_id, "text": text,
                   "parse_mode": "HTML", "disable_web_page_preview": True}
        try:
            r = requests.post(url, data=payload, timeout=15)
        except requests.exceptions.RequestException:
            return False, None
        if r.status_code == 200: return True, None
        if r.status_code == 429:
            try: ra = int(r.json().get("parameters", {}).get("retry_after", 5))
            except Exception: ra = 5
            return False, ra
        return False, None

    def _send_with_retry(self, text):
        for attempt in range(self.max_retries):
            ok_send, ra = self._post(text)
            if ok_send:
                with self._lock: self.sent += 1
                RUNNER.stats["tg_sent"] = self.sent
                return
            if ra is not None:
                time.sleep(ra + 1); continue
            delay = min(self.base_delay * (2 ** attempt), 60.0)
            time.sleep(delay + random.uniform(0, 0.75))
        with self._lock: self.failed += 1
        RUNNER.stats["tg_failed"] = self.failed


# ============================================================
# FILE HELPERS
# ============================================================
def _path(fname):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    return os.path.join(OUTPUT_DIR, fname)

def append_url(url, filename, lock, extra=""):
    with lock:
        try:
            with open(_path(filename), "a") as f:
                f.write(url + ("  # " + extra if extra else "") + "\n")
                f.flush()
        except Exception: pass

def load_seen_urls():
    seen = set(); counts = {}
    for fname in IMPORT_FILES:
        path = _path(fname)
        n = 0
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        line = line.strip()
                        if not line: continue
                        m = _URL_RE.match(line)
                        if m: seen.add(m.group(1)); n += 1
            except Exception: pass
        counts[fname] = n
    return seen, counts

def init_files(cumulative):
    for f in IMPORT_FILES:
        p = _path(f)
        if not cumulative:
            try:
                with open(p, "w"): pass
            except Exception: pass
        else:
            try:
                with open(p, "a"): pass
            except Exception: pass


# ============================================================
# CHECKER WORKER
# ============================================================
def checker_worker(cfg):
    global RUNNER
    RUNNER.set_state("running")
    RUNNER.started_at = time.time()
    RUNNER.push_log("info", "Starting checker...")

    previously_seen, counts = load_seen_urls()
    if previously_seen:
        RUNNER.push_log("info",
            "Imported {} previously-saved URLs (will be skipped)".format(
                len(previously_seen)))
    else:
        RUNNER.push_log("info", "No previously-saved URLs found - fresh start")

    init_files(cfg["cumulative_output"])
    RUNNER.stats["skipped"] = len(previously_seen)

    telegram = None
    if cfg["enable_telegram"] and cfg["tg_token"] and cfg["tg_chat_id"]:
        telegram = TelegramAlerter(cfg["tg_token"], cfg["tg_chat_id"])
        telegram.start()
        RUNNER.push_log("ok", "Telegram alerts enabled (chat {})".format(
            cfg["tg_chat_id"]))

    proxy_pool = None
    if cfg["enable_proxies"]:
        proxies = parse_proxies(PROXIES_RAW)
        if proxies:
            proxy_pool = ProxyPool(proxies)
            RUNNER.push_log("ok", "Loaded {} proxies".format(len(proxies)))

    RUNNER.push_log("info", "Workers: {}  Timeout: {}s  Batch: {}".format(
        cfg["max_workers"], cfg["timeout"], cfg["batch_size"]))

    historical_seen = set(previously_seen)
    seen = set()
    seen_cap = cfg["seen_cap"]
    file_lock = Lock()

    processed = 0
    batch_num = 0
    run_start = time.time()

    def handle(result, batch_num):
        url = result["url"]; status = result["status"]
        code = result.get("status_code", 0)
        msg = result.get("response_msg", "")
        if status == "ignored": return
        if url in historical_seen: return

        if status == "invalid_format":
            append_url(url, INVALID_URLS_FILE, file_lock)
            RUNNER.stats["invalid"] += 1
            if cfg["show_invalid"]:
                RUNNER.push_log("warn", "[{}] {} | {}".format(code, msg, url))
            if telegram and cfg["alert_invalid"]:
                telegram.enqueue(
                    "<b>INVALID FORMAT HIT</b>\n<code>{}</code>\n"
                    "HTTP: <code>{}</code>\n<i>{}</i>".format(
                        _html_escape(url), code, _html_escape(msg)))
        elif status == "private":
            append_url(url, PRIVATE_URLS_FILE, file_lock)
            RUNNER.stats["private"] += 1
            if cfg["show_private"]:
                RUNNER.push_log("info", "[{}] {} | {}".format(code, msg, url))
            if telegram and cfg["alert_private"]:
                telegram.enqueue("<b>PRIVATE DB</b>\n<code>{}</code>\n"
                                 "HTTP: <code>{}</code>".format(
                                     _html_escape(url), code))
        elif status == "valid_with_data":
            append_url(url, VALID_URLS_FILE, file_lock)
            RUNNER.stats["valid"] += 1
            if cfg["show_valid"]:
                RUNNER.push_log("ok", "[{}] {} | {}".format(code, msg, url))
            if telegram and cfg["alert_valid"]:
                telegram.enqueue(
                    "<b>VALID PUBLIC HIT</b>\n<code>{}</code>\n"
                    "HTTP: <code>{}</code>\n<i>{}</i>".format(
                        _html_escape(url), code, _html_escape(msg)))
        elif status == "valid_empty":
            append_url(url, EMPTY_URLS_FILE, file_lock)
            RUNNER.stats["empty"] += 1
            if cfg["show_empty"]:
                RUNNER.push_log("info", "[{}] {} | {}".format(code, msg, url))
        elif status == "deactivated":
            RUNNER.stats["deactivated"] += 1
            if cfg["show_dead"]:
                RUNNER.push_log("err", "[{}] {} | {}".format(code, msg, url))
        else:
            RUNNER.stats["errors"] += 1
            if cfg["show_errors"]:
                RUNNER.push_log("err", "[{}] {} | {}".format(code, msg, url))

    try:
        while not RUNNER.stop_event.is_set():
            RUNNER.wait_if_paused()
            if RUNNER.stop_event.is_set(): break

            batch = []
            while len(batch) < cfg["batch_size"]:
                if RUNNER.stop_event.is_set(): break
                RUNNER.wait_if_paused()
                if RUNNER.stop_event.is_set(): break
                u = generate_random_url()
                if u in historical_seen or u in seen: continue
                seen.add(u)
                if seen_cap > 0 and len(seen) > seen_cap:
                    drop = len(seen) - int(seen_cap * 0.9)
                    for _ in range(drop): seen.pop()
                batch.append(u)

            if not batch:
                if RUNNER.stop_event.is_set(): break
                continue

            batch_num += 1
            RUNNER.stats["batch"] = batch_num
            RUNNER.push_log("info",
                "=== Batch #{} - {} URLs - total checked: {} ===".format(
                    batch_num, len(batch), processed))

            t0 = time.time()
            with ThreadPoolExecutor(max_workers=cfg["max_workers"]) as ex:
                futs = {ex.submit(check_url_format, u, proxy_pool, cfg): u
                        for u in batch}
                for f in as_completed(futs):
                    try: handle(f.result(), batch_num)
                    except Exception: RUNNER.stats["errors"] += 1

            processed += len(batch)
            RUNNER.stats["processed"] = processed
            elapsed = time.time() - run_start
            RUNNER.stats["elapsed"] = elapsed
            RUNNER.stats["speed"] = processed / max(elapsed, 0.001)

            RUNNER.push_log("info",
                "Batch #{} done in {:.2f}s | total {:.1f}s | {:.1f} url/s".format(
                    batch_num, time.time() - t0, elapsed,
                    RUNNER.stats["speed"]))

    except Exception as e:
        RUNNER.push_log("err", "Runner crashed: {}".format(e))
    finally:
        if telegram: telegram.stop(drain_timeout=20.0)
        RUNNER.set_state("idle")
        RUNNER.stop_event.clear()
        RUNNER.pause_event.set()
        RUNNER.push_log("info",
            "=== STOPPED - {} batches, {} URLs checked ===".format(
                batch_num, processed))


# ============================================================
# ROUTES
# ============================================================
@app.route("/")
def index():
    return render_template("index.html")

# ---- keep-alive endpoint for cron-job.org -------------------
@app.route("/health")
def health():
    """
    Lightweight endpoint for external uptime pingers (e.g. cron-job.org).
    Returns current state + tiny stats snapshot. Never touches the
    filesystem or the network, so it's safe to hit every few minutes.
    """
    state = RUNNER.get_state()
    with RUNNER.lock:
        snap = {
            "state":   state,
            "batch":   RUNNER.stats.get("batch", 0),
            "checked": RUNNER.stats.get("processed", 0),
            "uptime":  int(time.time() - RUNNER.started_at)
                       if RUNNER.started_at else 0,
        }
    return jsonify({"ok": True, "ts": time.time(), **snap}), 200

# ---- start / pause / resume / stop --------------------------
@app.route("/api/start", methods=["POST"])
def api_start():
    if RUNNER.get_state() in ("running", "paused", "stopping"):
        return jsonify({"ok": False, "error": "already running"}), 400
    cfg = request.get_json(force=True) or {}

    cfg = {
        "max_workers":        int(cfg.get("max_workers", 200)),
        "timeout":            int(cfg.get("timeout", 8)),
        "max_proxy_retries":  int(cfg.get("max_proxy_retries", 1)),
        "batch_size":         int(cfg.get("batch_size", 5000)),
        "seen_cap":           int(cfg.get("seen_cap", 2_000_000)),
        "enable_proxies":     bool(cfg.get("enable_proxies", True)),
        "cumulative_output":  bool(cfg.get("cumulative_output", True)),
        "enable_telegram":    bool(cfg.get("enable_telegram", False)),
        "tg_token":           str(cfg.get("tg_token", "")).strip(),
        "tg_chat_id":         str(cfg.get("tg_chat_id", "")).strip(),
        "alert_valid":        bool(cfg.get("alert_valid", True)),
        "alert_invalid":      bool(cfg.get("alert_invalid", True)),
        "alert_private":      bool(cfg.get("alert_private", False)),
        "show_valid":         bool(cfg.get("show_valid", True)),
        "show_empty":         bool(cfg.get("show_empty", False)),
        "show_invalid":       bool(cfg.get("show_invalid", True)),
        "show_private":       bool(cfg.get("show_private", True)),
        "show_dead":          bool(cfg.get("show_dead", False)),
        "show_errors":        bool(cfg.get("show_errors", False)),
    }

    with RUNNER.lock:
        for k in RUNNER.stats: RUNNER.stats[k] = 0
        RUNNER.stats.update({"speed": 0.0, "elapsed": 0.0})
        RUNNER.log_q.clear()
        RUNNER.log_seq = 0

    RUNNER.cfg = cfg
    t = threading.Thread(target=checker_worker, args=(cfg,), daemon=True)
    RUNNER.thread = t
    t.start()
    return jsonify({"ok": True})

@app.route("/api/pause", methods=["POST"])
def api_pause():
    ok_ = RUNNER.request_pause()
    if ok_: RUNNER.push_log("info", "PAUSED")
    return jsonify({"ok": ok_, "state": RUNNER.get_state()})

@app.route("/api/resume", methods=["POST"])
def api_resume():
    ok_ = RUNNER.request_resume()
    if ok_: RUNNER.push_log("info", "RESUMED")
    return jsonify({"ok": ok_, "state": RUNNER.get_state()})

@app.route("/api/stop", methods=["POST"])
def api_stop():
    ok_ = RUNNER.request_stop()
    if ok_: RUNNER.push_log("warn", "STOP requested...")
    return jsonify({"ok": ok_, "state": RUNNER.get_state()})

@app.route("/api/stats")
def api_stats():
    stats, state = RUNNER.snapshot()
    return jsonify({"stats": stats, "state": state})

@app.route("/api/logs/stream")
def api_logs_stream():
    def gen():
        q = RUNNER.add_subscriber()
        try:
            with RUNNER.lock:
                history = list(RUNNER.log_q)[-200:]
            for e in history:
                yield "data: {}\n\n".format(json.dumps(e))
            while True:
                try:
                    entry = q.get(timeout=15)
                    yield "data: {}\n\n".format(json.dumps(entry))
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            RUNNER.remove_subscriber(q)
    return Response(stream_with_context(gen()),
                    mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache",
                             "X-Accel-Buffering": "no",
                             "Connection": "keep-alive"})


# ============================================================
# OPTIONAL SELF-KEEPALIVE (disabled by default; use cron-job.org)
# ============================================================
def _self_keepalive():
    """
    Pings our own /health every 10 minutes so Render's free tier
    doesn't sleep. Enable by setting SELF_KEEPALIVE=1 in env.
    Render injects RENDER_EXTERNAL_URL automatically.
    """
    if os.environ.get("SELF_KEEPALIVE", "0") != "1":
        return
    base = os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")
    if not base:
        return
    time.sleep(30)
    while True:
        try:
            requests.get(base + "/health", timeout=10)
        except Exception:
            pass
        time.sleep(600)

threading.Thread(target=_self_keepalive, daemon=True,
                 name="self-keepalive").start()


# ============================================================
# MAIN (local dev fallback)
# ============================================================
if __name__ == "__main__":
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, threaded=True, debug=False)