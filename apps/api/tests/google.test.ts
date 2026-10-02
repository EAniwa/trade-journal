import { afterEach,expect,it,vi } from 'vitest';
import { googleConfig,googleIdentity } from '../src/google';
afterEach(()=>vi.unstubAllEnvs());
const valid={sub:'stable-google-subject',email:'Trader@Example.com',email_verified:true,exp:Date.now()/1000+300,nonce:'expected'};
it('requires a nonce and verified Google email',()=> {
 expect(googleIdentity(valid,'expected')).toEqual({subject:'stable-google-subject',email:'trader@example.com'});
 for(const payload of [{...valid,nonce:'other'},{...valid,email_verified:false},{...valid,sub:''},{...valid,exp:undefined},{...valid,email:undefined}])expect(()=>googleIdentity(payload,'expected')).toThrow();
});
it('keeps Google unavailable until all credentials are configured',()=> {
 vi.stubEnv('GOOGLE_CLIENT_ID','client');vi.stubEnv('GOOGLE_CLIENT_SECRET','');vi.stubEnv('GOOGLE_REDIRECT_URI','http://localhost:3002/api/oauth/google/callback');expect(googleConfig()).toBeUndefined();
});
it('accepts HTTPS or local development callbacks and rejects plaintext remote callbacks',()=> {
 vi.stubEnv('GOOGLE_CLIENT_ID','client');vi.stubEnv('GOOGLE_CLIENT_SECRET','test-secret');
 for(const redirect of ['http://localhost:3002/api/oauth/google/callback','https://journal.example.com/api/oauth/google/callback']){vi.stubEnv('GOOGLE_REDIRECT_URI',redirect);expect(googleConfig()?.redirectUri).toBe(redirect);}
 vi.stubEnv('GOOGLE_REDIRECT_URI','http://remote.example.com/callback');expect(()=>googleConfig()).toThrow();
});
