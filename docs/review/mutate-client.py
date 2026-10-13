"""Mutation runner for the client (vitest). Usage: CHATTER_JS=... python3 -I mutate-client.py config.json

config.json: {"tests": ["src/state", ...], "mutations": [{"label": "...", "file": "src/x.ts",
"pairs": [["exact old text", "new text"], ...], "tests": [optional per-mutation list]}]}
Paths are relative to client/. Each mutation must match its old text exactly once. The runner runs the
unmutated baseline first (read it: a baseline that is not all green makes every verdict meaningless), applies one
mutation at a time, restores the file in a finally block, and runs the baseline again at the end. A mutation is
CAUGHT when vitest reports failed tests; the first red test names are printed. Never run it while an E2E run or
an executor is using the same tree.
"""
import subprocess, sys, os, re, shutil, json
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..', 'client')
ENV = dict(os.environ)  # CHATTER_JS must be set for the real-Chatter tests to run, not skip

def run(tests):
    r = subprocess.run(['timeout', '300', 'npx', 'vitest', 'run', *tests], cwd=ROOT, env=ENV, capture_output=True, text=True)
    out = r.stdout + r.stderr
    summ = re.findall(r'^\s+Tests\s+(.*\(\d+\))\s*$', out, re.M)
    red = sorted(set(re.findall(r'(?:FAIL|×)\s+(.*?)(?: \d+ms)?$', out, re.M)))
    return summ[-1] if summ else 'NO SUMMARY (' + str(r.returncode) + ')', red[:6]

def mutate(label, rel, pairs, tests):
    path = os.path.join(ROOT, rel)
    orig = open(path, encoding='utf-8').read()
    mutated = orig
    for old, new in pairs:
        assert mutated.count(old) == 1, (label, mutated.count(old), old[:60])
        mutated = mutated.replace(old, new)
    bak = path + '.mutbak'
    shutil.copy(path, bak)
    try:
        open(path, 'w', encoding='utf-8').write(mutated)
        summ, red = run(tests)
    finally:
        shutil.move(bak, path)
    verdict = 'CAUGHT' if re.search(r'\d+ failed', summ) else 'NOT CAUGHT'
    print(f'{label}: {verdict} [{summ}]')
    for t in red[:4]: print('    red:', t[:150])
    sys.stdout.flush()

if __name__ == '__main__':
    cfg = json.load(open(sys.argv[1]))
    tests = cfg['tests']
    print('baseline', run(tests)[0]); sys.stdout.flush()
    for m in cfg['mutations']:
        mutate(m['label'], m['file'], m['pairs'], m.get('tests', tests))
    print('after: baseline', run(tests)[0])
