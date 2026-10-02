// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import WorkspacePage from '../src/app/workspace/page';
const transport=vi.hoisted(()=>({read:vi.fn(),write:vi.fn()}));
vi.mock('../src/lib/hosted-client',()=>({hosted:transport.read,hostedWrite:transport.write,newImportKey:()=>"device-import-key",HostedError:class extends Error{status=401;}}));
let container:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{vi.spyOn(window,"scrollTo").mockImplementation(()=>{});Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});container=document.createElement('div');document.body.append(container);root=createRoot(container);transport.read.mockReset();transport.write.mockReset();transport.read.mockImplementation(async(path:string)=> {
  if(path==='me')return {user:{id:'test-user',email:'trader@test.invalid'}};
  if(path==='accounts')return {accounts:[{id:'account-1',name:'Broker one',currency:'USD',initialBalance:0,kind:'manual'}]};
  if(path.startsWith('performance'))return {currencies:['USD'],timeZone:'UTC',equity:[]};
  if(path.startsWith('trades'))return {trades:[],nextCursor:null};
  if(path.startsWith('documents/journal/'))return {document:{version:7,payload:{notes:'Existing reflection'}}};
  return {};
});});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
async function open(){await act(async()=>root.render(createElement(WorkspacePage)));}
async function click(label:string){const button=Array.from(container.querySelectorAll('button')).find(b=>b.textContent===label)!;expect(button).toBeTruthy();await act(async()=>button.click());}
it('loads private performance and offers an empty-history path',async()=>{await open();expect(container.textContent).toContain('Find your edge');expect(container.textContent).toContain('Create account');expect(transport.read).toHaveBeenCalledWith('accounts');});
it('saves journal changes using the loaded optimistic version',async()=>{await open();await click('Journal');expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Existing reflection');transport.write.mockResolvedValue({document:{version:8,payload:{notes:'Existing reflection'}}});await act(async()=>container.querySelector('.edge-journal form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));expect(transport.write).toHaveBeenCalledWith(expect.stringMatching(/^documents\/journal\/account-1:/),{version:7,payload:{notes:'Existing reflection'}},'PUT');expect(container.textContent).toContain('Saved to your journal');});
it('keeps the journal disabled when its document cannot be loaded',async()=>{transport.read.mockImplementation(async(path:string)=>{if(path==='me')return {user:{id:'user',email:'trader@test.invalid'}};if(path==='accounts')return {accounts:[{id:'account-1',name:'Broker one',currency:'USD',initialBalance:0,kind:'manual'}]};if(path.startsWith('performance'))return {currencies:[],timeZone:'UTC'};if(path.startsWith('trades'))return {trades:[],nextCursor:null};throw new Error('Connection unavailable');});await open();await click('Journal');expect((container.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);expect(container.textContent).toContain('Connection unavailable');expect(transport.write).not.toHaveBeenCalled();});
it('makes the broker statement timezone explicit',async()=>{await open();await click('Import');const input=container.querySelector('input[required]') as HTMLInputElement;expect(input.value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);expect(container.textContent).toContain('Statement timezone');expect(container.textContent).toContain('timezone shown on your broker statement');});

const account={id:'account-2',name:'Broker two',currency:'CAD',initialBalance:500,broker:'Example Broker',kind:'manual'};
async function withAccounts(){const fallback=transport.read.getMockImplementation()!;transport.read.mockImplementation(async(path:string)=>path==='accounts'?{accounts:[{...account,id:'account-1',name:'Broker one'},account]}:fallback(path));await open();}
it('opens an existing account and saves edited account fields',async()=>{await withAccounts();await click('Settings');await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Open Broker two"]')!.click());const dialog=container.querySelector('[role="dialog"]')!;expect(dialog.textContent).toContain('Edit trading account');expect(dialog.querySelector('input')!.value).toBe('Broker two');transport.write.mockResolvedValue({id:account.id});await act(async()=>dialog.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));expect(transport.write).toHaveBeenCalledWith('accounts/account-2',{name:'Broker two',currency:'CAD',initialBalance:500,broker:'Example Broker'},'PATCH');expect(container.querySelector('[role="dialog"]')).toBeNull();});
it('carries the chosen broker into CSV import and queues its file',async()=>{await withAccounts();await click('Settings');await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Open Broker two"]')!.click());await click('Import CSV');expect(container.querySelector('select')!.value).toBe('account-2');const input=container.querySelector<HTMLInputElement>('input[type="file"]')!;Object.defineProperty(input,'files',{configurable:true,value:[{name:'fills.csv',size:100,text:async()=> 'symbol,side\nAAPL,buy'}]});await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));transport.write.mockResolvedValue({job:{id:'job',status:'completed',result:{inserted:1,duplicates:0}}});await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));expect(transport.write).toHaveBeenCalledWith('imports',expect.objectContaining({accountId:'account-2',fileName:'fills.csv',content:'symbol,side\nAAPL,buy'}),'POST','device-import-key');});
it('opens manual trade entry for the chosen broker and requires a choice for generic imports',async()=>{await withAccounts();await click('Import');expect(container.querySelector('select')!.value).toBe('account-1');await click('Settings');await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Open Broker two"]')!.click());await click('Add manual trade');expect(container.querySelector('select')!.value).toBe('account-2');expect(container.textContent).toContain('Entry price');});
it('blocks rapid repeat uploads, clears accepted files, and explains existing fills',async()=>{
 await withAccounts();await click('Settings');await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Open Broker two"]')!.click());await click('Import CSV');
 const input=container.querySelector<HTMLInputElement>('input[type="file"]')!;
 let finishRead!:(value:string)=>void;const content=new Promise<string>(resolve=>{finishRead=resolve;});
 const readFile=vi.fn(()=>content);Object.defineProperty(input,'files',{configurable:true,value:[{name:'fills.csv',size:10,text:readFile}]});
 await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));
 transport.write.mockResolvedValue({job:{id:'already-saved',status:'completed',result:{inserted:0,duplicates:41,trades:19}}});
 const form=container.querySelector('form')!;
 await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 expect(readFile).toHaveBeenCalledOnce();await act(async()=>{finishRead('data');await content;});
 expect(transport.write).toHaveBeenCalledOnce();expect(container.textContent).toContain('Already imported · 41 fills are already saved');
 expect(container.textContent).toContain('Choose a broker statement');await click('View trades');expect(container.textContent).toContain('Trade history');
});
it('keeps management in Settings and requests the selected account and period',async()=>{
 await withAccounts();expect(container.querySelector('[aria-label="Open Broker two"]')).toBeNull();
 expect(transport.read).toHaveBeenCalledWith(expect.stringContaining('performance?accountId=account-1&period=1m'),expect.anything());
 const select=container.querySelector<HTMLSelectElement>('[aria-label="Active broker account"]')!;
 await act(async()=>{select.value='account-2';select.dispatchEvent(new Event('change',{bubbles:true}));});await click('2 weeks');
 expect(transport.read).toHaveBeenCalledWith(expect.stringContaining('performance?accountId=account-2&period=2w'),expect.anything());
 expect(transport.read).toHaveBeenCalledWith('trades?limit=30&accountId=account-2',expect.anything());
 await click('Settings');await click('Daytime');expect(container.querySelector('.edge-light')).toBeTruthy();await click('Nighttime');expect(container.querySelector('.edge-light')).toBeNull();
});
it('discards delayed performance from an account after the user switches away',async()=>{
 let resolveOld!:(value:unknown)=>void;const previous=transport.read.getMockImplementation()!;
 transport.read.mockImplementation((path:string,...args:unknown[])=>path.startsWith('performance?accountId=account-1')?new Promise(resolve=>{resolveOld=resolve;}):path.startsWith('performance?accountId=account-2')?Promise.resolve({currencies:['CAD'],timeZone:'UTC',moneyMade:222}):previous(path,...args));
 await withAccounts();const select=container.querySelector<HTMLSelectElement>('[aria-label="Active broker account"]')!;
 await act(async()=>{select.value='account-2';select.dispatchEvent(new Event('change',{bubbles:true}));});
 await act(async()=>{resolveOld({currencies:['USD'],timeZone:'UTC',moneyMade:9999});});expect(container.textContent).not.toContain('9,999');expect(container.textContent).toContain('222');
});
it('warns before permanent deletion, supports cancellation, and requires the final delete action',async()=>{
 await withAccounts();await click('Settings');await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Open Broker two"]')!.click());
 await click('Delete account');expect(container.textContent).toContain('You won’t be able to recover them.');expect(transport.write).not.toHaveBeenCalled();
 await click('Cancel');expect(container.textContent).not.toContain('Permanently delete account');await click('Delete account');
 transport.write.mockResolvedValue({deleted:true,id:'account-2'});await click('Permanently delete account');expect(transport.write).toHaveBeenCalledWith('accounts/account-2',{confirmation:'DELETE'},'DELETE');expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('offers account creation inside the picker without changing the selected account',async()=>{
 await withAccounts();const select=container.querySelector<HTMLSelectElement>('[aria-label="Active broker account"]')!;
 expect(Array.from(container.querySelectorAll('button')).some(b=>b.textContent==='Set up a broker account')).toBe(false);
 await act(async()=>{select.value='__new_account__';select.dispatchEvent(new Event('change',{bubbles:true}));});
 expect(container.querySelector('[role="dialog"]')).toBeTruthy();expect(select.value).toBe('account-1');
 expect(transport.read.mock.calls.some(([path])=>String(path).includes('accountId=__new_account__'))).toBe(false);
});
