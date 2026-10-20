"""Structure-only team-shape fixture from a Discovery run record (public-safe: no prompts, briefs, paths or messages)."""
import json, os, re, sys, collections
src, out = sys.argv[1], sys.argv[2]
run = os.path.basename(src.rstrip('/'))
ROLE = re.compile(r'^(root|lead-[a-z0-9-]+)$')
AGENT = re.compile(r'^R(:s[0-9]+)*$')
def rel(x): return x.replace(run, 'R')
rows = []
for line in open(os.path.join(src, 'spawn-journal.jsonl')):
    r = json.loads(line); ev = r.get('event') or {}
    k = ev.get('kind')
    if k not in ('spawned', 'settled'): continue
    row = {'kind': k, 'journal': rel(r['root']), 'id': rel(ev['id']), 'at': ev['at']}
    if k == 'spawned':
        lab = ev.get('label') or ''
        row['role'] = lab if ROLE.match(lab) else 'task'
    else:
        row['status'] = ev.get('status')
        v = ev.get('verdict') or {}
        if 'valid' in v: row['valid'] = v['valid']
        ms = (ev.get('spent') or {}).get('ms')
        if ms is not None: row['ms'] = ms
    rows.append(row)
coord = []
p = os.path.join(src, 'coordination-log.jsonl')
if os.path.exists(p):
    for line in open(p):
        r = json.loads(line); ev = r.get('event') or {}
        t = ev.get('type'); body = next((v for k, v in ev.items() if k != 'type' and isinstance(v, dict)), {})
        row = {'at': r.get('at'), 'type': t, 'owner': (r.get('ownerId') or '')[7:19]}
        for key in ('toWorker', 'from', 'by'):
            v = body.get(key)
            if isinstance(v, str):
                v = rel(v)
                row[key] = v if AGENT.match(v) else 'other'
        if 'interrupt' in body: row['interrupt'] = bool(body['interrupt'])
        if t == 'steer': row['delivered'] = bool(body.get('delivered'))
        coord.append(row)
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, run + '.spawn.jsonl'), 'w') as f:
    for row in rows: f.write(json.dumps(row) + '\n')
with open(os.path.join(out, run + '.coord.jsonl'), 'w') as f:
    for row in coord: f.write(json.dumps(row) + '\n')
# Features, so the lead's label can be checked against the record.
ids = sorted({r['id'] for r in rows if r['kind'] == 'spawned' and r['id'] != 'R'})
parent = lambda i: i.rsplit(':', 1)[0] if ':' in i else None
depth = lambda i: i.count(':')
kids = collections.Counter(parent(i) for i in ids)
settled_in = collections.Counter()
for r in rows:
    if r['kind'] == 'settled' and r['journal'] != 'R/' + r['id']:
        settled_in[r['journal'].split('/')[-1]] += 1
roles = collections.Counter(r['role'] for r in rows if r['kind'] == 'spawned' and r['journal'] == ('R' if ':' not in r['id'] or r['id'].count(':') == 1 else r['journal']))
feat = {'run': run, 'agents': len(ids) + 1, 'depth': max(map(depth, ids)) if ids else 0,
        'fan_out_root': kids.get('R', 0), 'fan_out_max': max(kids.values()) if kids else 0,
        'internal_nodes': sum(1 for k in kids if k != 'R'), 'settlements_by_receiver': dict(settled_in.most_common()),
        'steers': sum(1 for c in coord if c['type'] == 'steer'), 'steers_delivered': sum(1 for c in coord if c.get('delivered')),
        'messages_to': dict(collections.Counter(c.get('toWorker', '-') for c in coord if c['type'] in ('instruction', 'steer')).most_common(4)),
        'from': dict(collections.Counter(c['from'] for c in coord if 'from' in c).most_common(4)), 'coord_rows': len(coord),
        'coord_types': dict(collections.Counter(c['type'] for c in coord).most_common())}
print(json.dumps(feat))
