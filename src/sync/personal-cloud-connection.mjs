import { createPersonalCloudStorage } from "../storage/personal-cloud-storage.mjs";
const SCOPE = "https://www.googleapis.com/auth/cloudplatformprojects.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PROJECT_URL = "https://cloudresourcemanager.googleapis.com/v3/projects/";
const fail = (code, message) => Object.assign(new Error(message), { code });
const clientOk = v => typeof v === "string" && /^[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(v.trim());
const projectOk = v => typeof v === "string" && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(v.trim());
function b64url(bytes) { let s=""; for (const b of bytes) s+=String.fromCharCode(b); return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
function random(crypto, n) { const a=new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }

/** Optional user-owned Google Cloud project connection. Tokens are memory-only. */
export class PersonalCloudConnection {
  constructor({persistence=createPersonalCloudStorage(),cryptoImpl=globalThis.crypto,location=globalThis.location,history=globalThis.history,fetchImpl=globalThis.fetch,now=()=>Date.now()}={}) {
    if(!persistence||!cryptoImpl?.subtle||!cryptoImpl?.getRandomValues||!location||!fetchImpl) throw new TypeError("Personal cloud persistence, Web Crypto, location and fetch are required");
    Object.assign(this,{persistence,crypto:cryptoImpl,location,history,fetch:fetchImpl,now});
    this.accessToken=null; this.expiresAt=0; this.config=this.readConfig();
  }
  readConfig() { try { const v=this.persistence.readConfig(); return v?this.validate(JSON.parse(v)):null; } catch { return null; } }
  validate(v) { if(!v||!clientOk(v.clientId)||!projectOk(v.projectId)) throw fail("CLOUD_CONFIG_INVALID","Enter a valid Google OAuth client ID and Google Cloud project ID."); return Object.freeze({clientId:v.clientId.trim(),projectId:v.projectId.trim()}); }
  get status() { return Object.freeze({mode:this.config?"PERSONAL_CLOUD_CONFIGURED":"LOCAL_ONLY",connected:!!(this.accessToken&&this.expiresAt>this.now()),tokenPersistence:"MEMORY_ONLY",dataUploadEnabled:false,projectId:this.config?.projectId||null}); }
  async connect(input) {
    this.config=this.validate(input); this.persistence.writeConfig(JSON.stringify(this.config));
    const verifier=random(this.crypto,48), state=random(this.crypto,32);
    const digest=await this.crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier));
    this.persistence.writeTransient("aurelia.personal-cloud.oauth-verifier.v1",verifier); this.persistence.writeTransient("aurelia.personal-cloud.oauth-state.v1",state);
    const redirectUri=this.location.origin+this.location.pathname;
    const url=new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search=new URLSearchParams({client_id:this.config.clientId,redirect_uri:redirectUri,response_type:"code",scope:SCOPE,state,code_challenge:b64url(new Uint8Array(digest)),code_challenge_method:"S256",access_type:"online",include_granted_scopes:"true",prompt:"consent"}).toString();
    this.location.assign(url.toString()); return Object.freeze({redirectUri,scope:SCOPE});
  }
  cleanUrl() { if(this.history?.replaceState) this.history.replaceState({},"",this.location.origin+this.location.pathname+(this.location.hash||"")); }
  async completeRedirect() {
    const p=new URLSearchParams(this.location.search||""), code=p.get("code"); if(!code) return this.status;
    const state=p.get("state"), expected=this.persistence.readTransient("aurelia.personal-cloud.oauth-state.v1"), verifier=this.persistence.readTransient("aurelia.personal-cloud.oauth-verifier.v1");
    this.persistence.clearTransient("aurelia.personal-cloud.oauth-state.v1"); this.persistence.clearTransient("aurelia.personal-cloud.oauth-verifier.v1");
    if(!state||state!==expected||!verifier||!this.config) { this.cleanUrl(); throw fail("CLOUD_OAUTH_STATE_INVALID","Google authorization could not be verified. Start again."); }
    if(p.has("error")) { this.cleanUrl(); throw fail("CLOUD_OAUTH_DENIED","Google authorization was cancelled or denied."); }
    const redirectUri=this.location.origin+this.location.pathname;
    const response=await this.fetch(TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:this.config.clientId,code,code_verifier:verifier,grant_type:"authorization_code",redirect_uri:redirectUri})});
    const token=await response.json(); this.cleanUrl();
    if(!response.ok||typeof token.access_token!=="string"||!Number.isFinite(token.expires_in)) throw fail("CLOUD_TOKEN_EXCHANGE_FAILED","Google token exchange failed. Check OAuth client and redirect URI.");
    this.accessToken=token.access_token; this.expiresAt=this.now()+token.expires_in*1000;
    try { await this.verifyProjectAccess(); } catch(e) { this.accessToken=null; this.expiresAt=0; throw e; }
    return this.status;
  }
  async verifyProjectAccess() {
    if(!this.accessToken||this.expiresAt<=this.now()) throw fail("CLOUD_NOT_CONNECTED","Connect Google before verifying project access.");
    const r=await this.fetch(PROJECT_URL+encodeURIComponent(this.config.projectId),{headers:{Authorization:"Bearer "+this.accessToken}});
    if(!r.ok) throw fail("CLOUD_PROJECT_ACCESS_DENIED","This Google account cannot read the selected project. Check its ID and IAM access.");
    const p=await r.json(); if(p.projectId!==this.config.projectId) throw fail("CLOUD_PROJECT_MISMATCH","Google Cloud returned a different project.");
    return Object.freeze({projectId:p.projectId,projectNumber:p.projectNumber||null,lifecycleState:p.state||null});
  }
  disconnect() {
    const token=this.accessToken; this.accessToken=null; this.expiresAt=0; this.persistence.clearTransient("aurelia.personal-cloud.oauth-state.v1"); this.persistence.clearTransient("aurelia.personal-cloud.oauth-verifier.v1"); this.persistence.clearConfig(); this.config=null;
    if(token) void this.fetch("https://oauth2.googleapis.com/revoke?token="+encodeURIComponent(token),{method:"POST",mode:"no-cors"}).catch(()=>{});
    return this.status;
  }
}
export function mountPersonalCloudPanel({connection,document=globalThis.document}={}) {
  if(!connection||!document?.body) throw new TypeError("Connection and document are required");
  if(document.getElementById("aurelia-personal-cloud")) return;
  const panel=document.createElement("details"); panel.id="aurelia-personal-cloud";
  panel.style.cssText="position:fixed;right:14px;bottom:calc(92px + env(safe-area-inset-bottom,0px));z-index:35;width:min(340px,calc(100vw - 28px));color:#f7f2e7;background:#10271d;border:1px solid rgba(220,194,133,.4);border-radius:16px;padding:12px;font:14px system-ui;box-shadow:0 12px 36px #0009";
  const summary=document.createElement("summary"); summary.textContent="Personal cloud · optional"; summary.style.cssText="cursor:pointer;color:#e2c783;font-weight:600";
  const status=document.createElement("p"); status.style.cssText="margin:10px 0;color:#afc0b5";
  const client=document.createElement("input"), project=document.createElement("input");
  client.placeholder="Google OAuth client ID"; project.placeholder="Google Cloud project ID";
  for(const input of [client,project]) { input.autocomplete="off"; input.spellcheck=false; input.style.cssText="display:block;width:100%;box-sizing:border-box;margin:8px 0;padding:10px;border-radius:8px;border:1px solid #40564a;background:#081711;color:#fff"; }
  const connect=document.createElement("button"); connect.type="button"; connect.textContent="Connect Google Cloud"; connect.style.cssText="padding:9px 12px;border-radius:8px;background:#e2c783;color:#1b1303;font-weight:600";
  const disconnect=document.createElement("button"); disconnect.type="button"; disconnect.textContent="Disconnect"; disconnect.style.cssText="margin-left:8px;padding:9px 12px;border-radius:8px;background:#263d31;color:#fff";
  const note=document.createElement("small"); note.textContent="Local data stays on this device. This connection only verifies read access to your project; it does not upload or sync PMS data."; note.style.cssText="display:block;margin-top:10px;color:#afc0b5;line-height:1.45";
  const refresh=()=>{const s=connection.status;status.textContent=s.connected?"Connected · "+s.projectId+" · read-only":s.mode==="PERSONAL_CLOUD_CONFIGURED"?"Project configured · sign-in required":"Local-only · no cloud connection";disconnect.hidden=!connection.config;};
  connect.addEventListener("click",async()=>{try{await connection.connect({clientId:client.value,projectId:project.value});}catch(e){status.textContent=e.message;}});
  disconnect.addEventListener("click",()=>{connection.disconnect();refresh();});
  panel.append(summary,status,client,project,connect,disconnect,note); document.body.append(panel); refresh();
  void connection.completeRedirect().then(refresh).catch(e=>{status.textContent=e.message;});
  return panel;
}
