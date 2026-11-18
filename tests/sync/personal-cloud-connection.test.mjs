import test from "node:test";
import assert from "node:assert/strict";
import { PersonalCloudConnection } from "../../src/sync/personal-cloud-connection.mjs";
import { createPersonalCloudStorage } from "../../src/storage/personal-cloud-storage.mjs";


function harness({search="",projectStatus=200}={}) {
 const local=new Map(),sessionMap=new Map(),calls=[],assigned=[];
 const storage={getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,v),removeItem:k=>local.delete(k)};
 const session={getItem:k=>sessionMap.get(k)??null,setItem:(k,v)=>sessionMap.set(k,v),removeItem:k=>sessionMap.delete(k)};
 const cryptoImpl={getRandomValues:a=>{a.forEach((_,i)=>a[i]=(i*17+31)%255);return a;},subtle:{digest:async(_a,d)=>new Uint8Array(32).fill(d.byteLength)}};
 let query=search; const location={origin:"https://aurelia.example",pathname:"/app",get search(){return query;},hash:"",assign:u=>assigned.push(u)};
 const history={replaceState(){query="";}};
 const fetchImpl=async(url,options={})=>{calls.push({url,options});if(url.includes("/token"))return{ok:true,json:async()=>({access_token:"memory-token",expires_in:3600})};if(url.includes("cloudresourcemanager"))return{ok:projectStatus===200,json:async()=>({projectId:"aurelia-test-12345",projectNumber:"123",state:"ACTIVE"})};return{ok:true,json:async()=>({})};};
 return{connection:new PersonalCloudConnection({persistence:createPersonalCloudStorage({storage,session}),cryptoImpl,location,history,fetchImpl,now:()=>1000}),storage,session,calls,assigned,setSearch:value=>{query=value;}};
}
const clientId="1234567890-abcdef.apps.googleusercontent.com",projectId="aurelia-test-12345";
test("defaults to local-only with no data upload",()=>{const h=harness();assert.equal(h.connection.status.mode,"LOCAL_ONLY");assert.equal(h.connection.status.dataUploadEnabled,false);});
test("rejects malformed OAuth client and project IDs",async()=>{const h=harness();await assert.rejects(h.connection.connect({clientId:"bad",projectId}),e=>e.code==="CLOUD_CONFIG_INVALID");await assert.rejects(h.connection.connect({clientId,projectId:"Bad Project"}),e=>e.code==="CLOUD_CONFIG_INVALID");assert.equal(h.assigned.length,0);});
test("starts PKCE authorization and stores only public config",async()=>{const h=harness();const x=await h.connection.connect({clientId,projectId});const u=new URL(h.assigned[0]);assert.equal(u.searchParams.get("response_type"),"code");assert.equal(u.searchParams.get("code_challenge_method"),"S256");assert.equal(u.searchParams.get("redirect_uri"),"https://aurelia.example/app");assert.match(x.scope,/cloudplatformprojects\.readonly/);assert.ok(h.session.getItem("aurelia.personal-cloud.oauth-verifier.v1"));assert.equal(h.storage.getItem("aurelia.personal-cloud.config.v1").includes("token"),false);});
test("rejects OAuth state mismatch before token exchange",async()=>{const h=harness({search:"?code=abc&state=wrong"});await h.connection.connect({clientId,projectId});await assert.rejects(h.connection.completeRedirect(),e=>e.code==="CLOUD_OAUTH_STATE_INVALID");assert.equal(h.calls.length,0);});
test("exchanges authorization code and verifies project without persisting token",async()=>{const h=harness({search:"?code=abc&state=good"});await h.connection.connect({clientId,projectId});h.session.setItem("aurelia.personal-cloud.oauth-state.v1","good");const s=await h.connection.completeRedirect();assert.equal(s.connected,true);assert.equal(s.projectId,projectId);assert.equal(s.tokenPersistence,"MEMORY_ONLY");assert.equal(s.dataUploadEnabled,false);assert.equal(h.storage.getItem("aurelia.personal-cloud.config.v1").includes("memory-token"),false);});
test("denies access when Google rejects project lookup",async()=>{const h=harness({search:"?code=abc&state=good",projectStatus:403});await h.connection.connect({clientId,projectId});h.session.setItem("aurelia.personal-cloud.oauth-state.v1","good");await assert.rejects(h.connection.completeRedirect(),e=>e.code==="CLOUD_PROJECT_ACCESS_DENIED");assert.equal(h.connection.status.connected,false);});
test("reports Google authorization cancellation without requiring a code",async()=>{const h=harness();await h.connection.connect({clientId,projectId});const state=h.session.getItem("aurelia.personal-cloud.oauth-state.v1");h.setSearch("?error=access_denied&state="+encodeURIComponent(state));await assert.rejects(h.connection.completeRedirect(),e=>e.code==="CLOUD_OAUTH_DENIED");assert.equal(h.calls.length,0);assert.equal(h.session.getItem("aurelia.personal-cloud.oauth-state.v1"),null);assert.equal(h.session.getItem("aurelia.personal-cloud.oauth-verifier.v1"),null);assert.equal(h.connection.status.connected,false);});
test("disconnect clears config and in-memory token",async()=>{const h=harness();await h.connection.connect({clientId,projectId});h.connection.accessToken="memory-token";h.connection.expiresAt=99999;h.connection.disconnect();assert.equal(h.connection.status.mode,"LOCAL_ONLY");assert.equal(h.storage.getItem("aurelia.personal-cloud.config.v1"),null);});
