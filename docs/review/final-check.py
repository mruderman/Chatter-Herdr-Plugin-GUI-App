"""The closing check of a milestone, on the final tree. Usage: CHATTER_JS=... python3 -I final-check.py

Runs typecheck, the client unit tests, the root tests, the build, check:dist and the E2E suite, then the three gate
mutations of CLAUDE.md (break canSee; drop the @everyone rule; drop the CSP header), each of which must turn its
named spec red, restoring each file afterwards. Prints counts. It edits tracked files temporarily: run it on a clean
tree with nothing else running, and check `git status` afterwards.
"""
import sys
import subprocess, os, re, shutil, sys
HERE=os.path.dirname(os.path.abspath(__file__))
ROOT=os.path.abspath(os.path.join(HERE,'..','..'))
ENV=dict(os.environ)
if not ENV.get('CHATTER_JS'): sys.exit('set CHATTER_JS to a built Chatter checkout (dist/bin/chatter.js)')
def sh(cmd, cwd=ROOT, timeout=900):
    r=subprocess.run(cmd, cwd=cwd, env=ENV, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout+r.stderr
def out(label, text): print(label, text); sys.stdout.flush()
head=sh(['git','log','--oneline','-1'])[1].strip(); out('HEAD', head)
rc,o=sh(['npm','--prefix','client','run','typecheck']); out('typecheck', 'clean' if rc==0 and 'error' not in o.lower() else o[-300:])
rc,o=sh(['npm','--prefix','client','test']); out('client unit', ' | '.join(re.findall(r'(Test Files .*|Tests .*)', o)[-2:]))
rc,o=sh(['npm','test']); out('root npm test', ' '.join(f'{k}={v}' for k,v in re.findall(r'^# (tests|pass|fail|skipped) (\d+)', o, re.M)))
rc,o=sh(['npm','--prefix','client','run','build']); out('build', 'ok' if rc==0 else o[-300:])
rc,o=sh(['npm','--prefix','client','run','check:dist']); out('check:dist', o.strip().splitlines()[-1])
rc,o=sh(['npm','--prefix','client','run','e2e']); out('e2e', ' | '.join(re.findall(r'(\d+ passed[^\n]*|\d+ failed[^\n]*)', o)))
muts=[
 ('break canSee (DM visible to everyone)','bridge/src/messages.js',"export function canSee(member, row) {\n","export function canSee(member, row) {\n  return true;\n",'e2e/gate-dm-privacy.spec.ts'),
 ("drop the @everyone rule",'bridge/src/policy.js',"    if (everyone && !admin) {","    if (false && everyone && !admin) {",'e2e/gate-everyone.spec.ts'),
 ('drop the CSP header','bridge/src/static.js',"    'Content-Security-Policy': CSP,\n","",'e2e/smoke.spec.ts'),
]
for label,rel,old,new,spec in muts:
    path=os.path.join(ROOT,rel); orig=open(path,encoding='utf-8').read()
    assert orig.count(old)==1,(label,orig.count(old))
    shutil.copy(path,path+'.mutbak')
    try:
        open(path,'w',encoding='utf-8').write(orig.replace(old,new))
        rc,o=sh(['npm','--prefix','client','run','e2e','--',spec,'--reporter=line'])
    finally:
        shutil.move(path+'.mutbak',path)
    failed=re.findall(r'(\d+ failed)',o); passed=re.findall(r'(\d+ passed)',o)
    out('gate mutation: '+label, f"{'RED' if failed else 'NOT RED'} in {spec} ({', '.join(failed+passed)})")
rc,o=sh(['git','status','--short']); out('tree after', o.strip().replace('\n',' | '))
out('done','')
