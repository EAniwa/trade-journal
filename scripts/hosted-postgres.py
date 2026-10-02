import json
import os
import secrets
import subprocess
from pathlib import Path

repo = Path(__file__).resolve().parents[1]
cluster = Path('/private/tmp/trade-journal-postgres')
socket = Path('/private/tmp/trade-journal-postgres-socket')
socket.mkdir(mode=0o700, exist_ok=True)
socket.chmod(0o700)
if not (cluster / 'PG_VERSION').exists():
    subprocess.run(['initdb', '-D', str(cluster), '--auth-local=trust', '--auth-host=scram-sha-256'], check=True, stdout=subprocess.DEVNULL)
status = subprocess.run(['pg_ctl', '-D', str(cluster), 'status'], capture_output=True)
if status.returncode:
    subprocess.run(['pg_ctl', '-D', str(cluster), '-l', '/private/tmp/trade-journal-postgres.log', '-o', f'-p 55432 -h 127.0.0.1 -k {socket}', 'start'], check=True)
admin = f'postgresql://{os.environ.get("USER", "kofiedem")}@/postgres?host={socket}&port=55432'
config_file = Path('/private/tmp/trade-journal-hosted-config.json')
if config_file.exists():
    config = json.loads(config_file.read_text())
else:
    passwords = {role: secrets.token_hex(24) for role in ['journal_api', 'journal_worker']}
    sql = '\n'.join(f"CREATE ROLE {role} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '{password}';" for role, password in passwords.items())
    subprocess.run(['psql', admin, '-v', 'ON_ERROR_STOP=1'], input=sql, text=True, check=True, stdout=subprocess.DEVNULL)
    config = {'admin': admin, 'api': f'postgresql://journal_api:{passwords["journal_api"]}@127.0.0.1:55432/postgres', 'worker': f'postgresql://journal_worker:{passwords["journal_worker"]}@127.0.0.1:55432/postgres'}
    config_file.write_text(json.dumps(config))
    config_file.chmod(0o600)
for migration in sorted((repo / 'apps/api/migrations').glob('*.sql')):
    subprocess.run(['psql', admin, '-v', 'ON_ERROR_STOP=1', '-f', str(migration)], check=True, stdout=subprocess.DEVNULL)
grants = '''
GRANT USAGE ON SCHEMA public TO journal_api,journal_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON journal_users,journal_sessions,journal_auth_limits,journal_accounts,journal_executions,journal_trades,journal_documents,journal_jobs,journal_identities,journal_auth_transfers TO journal_api;
GRANT EXECUTE ON FUNCTION journal_claim_job(),journal_renew_job(uuid,uuid,uuid) TO journal_worker;
'''
subprocess.run(['psql', admin, '-v', 'ON_ERROR_STOP=1'], input=grants, text=True, check=True, stdout=subprocess.DEVNULL)
print('Local PostgreSQL ready on 127.0.0.1:55432. Restricted API and worker roles configured; credentials saved in a private temporary file.')
