import argparse
import json
import os
import subprocess
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('mode',choices=['tests','api','worker','preview','typecheck','stack'])
args=parser.parse_args()
supabase_runtime=Path(__file__).resolve().parents[1]/'supabase-runtime.json'
default_runtime=str(supabase_runtime) if supabase_runtime.is_file() else '/private/tmp/trade-journal-hosted-config.json'
config_path='/private/tmp/trade-journal-hosted-config.json' if args.mode=='tests' else os.environ.get('JOURNAL_CONFIG_FILE',default_runtime)
config=json.loads(Path(config_path).read_text())
env=dict(os.environ)
env.update(JOURNAL_DATABASE_URL=config['api'],JOURNAL_WORKER_URL=config['worker'],JOURNAL_DATABASE_SCHEMA=config.get('schema','public'),JOURNAL_DATABASE_SSL='1' if config.get('ssl') else '0',JOURNAL_DATABASE_POOL_MAX=str(config.get('poolMax',12)),JOURNAL_ALLOW_REGISTRATION='1',JOURNAL_DEMO='0' if config.get('projectUrl') else '1')
if config.get('caFile'): env['JOURNAL_DATABASE_CA_FILE']=config['caFile']
else: env.pop('JOURNAL_DATABASE_CA_FILE',None)
if args.mode=='tests': env.update(JOURNAL_TEST_DATABASE_URL=config['api'],JOURNAL_TEST_WORKER_URL=config['worker'],JOURNAL_TEST_ADMIN_URL=config['admin'])
repo=str(Path(__file__).resolve().parents[1])
commands={'tests':['pnpm','test'],'api':['pnpm','--filter','journal-api','dev'],'worker':['pnpm','--filter','journal-api','worker'],'typecheck':['pnpm','--filter','journal-api','typecheck'],'preview':['pnpm','--filter','web','exec','next','start','-p','3002']}
if args.mode in ('preview','stack'):
    env.update(JOURNAL_PREVIEW='1',JOURNAL_HOSTED_ONLY='1',JOURNAL_SERVICE_URL='http://127.0.0.1:4000',JOURNAL_DATA_DIR='/private/tmp/trade-journal-hosted-web-empty')
if args.mode=='stack':
    children=[]
    try:
        for mode in ['api','worker','preview']:
            children.append(subprocess.Popen(commands[mode],cwd=repo,env=env))
        while True:
            for child in children:
                if child.poll() is not None:
                    raise SystemExit(child.returncode)
            import time
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        for child in children:
            child.terminate()
else:
    raise SystemExit(subprocess.call(commands[args.mode],cwd=repo,env=env))
