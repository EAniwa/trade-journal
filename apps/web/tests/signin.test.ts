// @vitest-environment jsdom
import { act,createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import WorkspacePage from '../src/app/workspace/page';
const api=vi.hoisted(()=>({read:vi.fn(),write:vi.fn()}));
vi.mock('../src/lib/hosted-client',()=>({hosted:api.read,hostedWrite:api.write,HostedError:class extends Error{status=401;}}));
let div:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});api.read.mockReset();api.write.mockReset();api.read.mockImplementation(async(path:string)=>{if(path==='me')throw Object.assign(new Error('Sign in'),{status:401});if(path==='auth/providers')return {google:{enabled:false}};return {};});div=document.createElement('div');document.body.append(div);root=createRoot(div);});
afterEach(async()=>{await act(async()=>root.unmount());div.remove();});
async function open(){await act(async()=>root.render(createElement(WorkspacePage)));}
async function click(text:string){await act(async()=>Array.from(div.querySelectorAll('button')).find(b=>b.textContent===text)!.click());}
it('offers email sign-in and clearly marks unconfigured Google sign-in',async()=>{await open();expect(div.textContent).toContain('Welcome back');expect(div.querySelector('a.edge-google')?.getAttribute('aria-disabled')).toBe('true');expect(div.querySelector('a.edge-google')?.getAttribute('href')).toBeNull();expect(div.querySelector('nav')).toBeNull();});
it('creates a focused registration form with confirmation and password requirements',async()=>{await open();await click('Create an account');expect(div.textContent).toContain('Create your workspace');expect(div.textContent).toContain('Use at least 12 characters');expect(div.querySelectorAll('input[type="password"]')).toHaveLength(2);expect(div.querySelector('form')?.getAttribute('aria-label')).toBe('Create account');});
it('reveals a password only after an explicit visibility toggle',async()=>{await open();const toggle=div.querySelector('button[aria-label="Show password"]') as HTMLButtonElement;await act(async()=>toggle.click());expect(div.querySelector('input[autocomplete="current-password"]')?.getAttribute('type')).toBe('text');expect(div.querySelector('button[aria-label="Hide password"]')?.getAttribute('aria-pressed')).toBe('true');});
it('enables Google navigation when the backend provider is configured',async()=>{api.read.mockImplementation(async(path:string)=>{if(path==='me')throw new Error('Sign in');return {google:{enabled:true}};});await open();expect(div.querySelector('a.edge-google')?.getAttribute('href')).toBe('/api/oauth/google/start');expect(div.querySelector('a.edge-google')?.getAttribute('aria-disabled')).toBe('false');});
