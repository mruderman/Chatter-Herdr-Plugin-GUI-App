"""Mutation runner for the bridge (node --test). Usage: CHATTER_JS=... python3 -I mutate-bridge.py config.json
Optional: MUT_TESTS=/abs/a.test.js,/abs/b.test.js to run only those files (default: bridge/test/*.test.js).

config.json is a list of {"label": "...", "file": "bridge/src/x.js", "pairs": [["exact old", "new"], ...]}.
Paths are relative to the repository root. Read the printed baseline first: it must be all green, or every verdict
is meaningless (an earlier sweep was void because the runner passed a directory to `node --test`, which fails).
The file is restored in a finally block; the baseline runs again at the end. Do not run it while an E2E run or an
executor uses the same tree. A mutation that adds a statement with no arguments may be invisible to a test that
counts statements by their arguments: make the mutation look like the code it stands for.
"""
import subprocess, os, shutil, re, json, sys
HERE=os.path.dirname(os.path.abspath(__file__))
ROOT=os.path.abspath(os.path.join(HERE,'..','..'))
ENV=dict(os.environ)  # CHATTER_JS must be set for the real-Chatter tests to run, not skip
def run():
    r=subprocess.run(['timeout','400','node','--test','--test-reporter=tap']+(os.environ['MUT_TESTS'].split(',') if os.environ.get('MUT_TESTS') else sorted(__import__('glob').glob(ROOT+'/bridge/test/*.test.js'))),cwd=ROOT,env=ENV,capture_output=True,text=True)
    out=r.stdout+r.stderr
    fail=re.findall(r'^# fail (\d+)',out,re.M)
    ok=re.findall(r'^# pass (\d+)',out,re.M)
    red=re.findall(r'^\s*not ok \d+ - (.*)$',out,re.M)
    return (ok[-1] if ok else '?', fail[-1] if fail else '?', red)
cfg=json.load(open(sys.argv[1]))
print('baseline', run()[:2]); sys.stdout.flush()
for m in cfg:
    path=os.path.join(ROOT,m['file']); orig=open(path,encoding='utf-8').read(); mut=orig
    for old,new in m['pairs']:
        assert mut.count(old)==1,(m['label'],mut.count(old),old[:50]); mut=mut.replace(old,new)
    shutil.copy(path,path+'.mutbak')
    try:
        open(path,'w',encoding='utf-8').write(mut); ok,fail,red=run()
    finally:
        shutil.move(path+'.mutbak',path)
    print(f"{'CAUGHT ' if fail not in ('0','?') else 'SURVIVED'} {m['label']} [pass {ok}, fail {fail}]"+(f" <- {red[0][:110]}" if red else ''))
    sys.stdout.flush()
print('after', run()[:2])
