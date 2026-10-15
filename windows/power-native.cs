using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace ScriptFactory {
 public sealed class PowerSession {
  public int id; public string account; public string account_sid; public string state; public double? idle_seconds;
 }
 public sealed class PowerSnapshot {
  public bool complete; public string api_account; public string excluded_sid;
  public bool suspend_supported; public bool suspend_privilege; public PowerSession[] sessions;
 }
 public static class PowerNative {
  [StructLayout(LayoutKind.Sequential)] struct SessionInfo { public int Id; public IntPtr Station; public int State; }
  // wtsapi32.h: WCHAR arrays are 33/21/18 elements, LARGE_INTEGER uses 8-byte alignment.
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct InfoLevel1 {
   public uint SessionId; public int State; public int Flags;
   [MarshalAs(UnmanagedType.ByValTStr,SizeConst=33)] public string Station;
   [MarshalAs(UnmanagedType.ByValTStr,SizeConst=21)] public string User;
   [MarshalAs(UnmanagedType.ByValTStr,SizeConst=18)] public string Domain;
   public long LogonTime, ConnectTime, DisconnectTime, LastInputTime, CurrentTime;
   public uint IncomingBytes, OutgoingBytes, IncomingFrames, OutgoingFrames, IncomingCompressedBytes, OutgoingCompressedBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct InfoEx { public uint Level; public InfoLevel1 Data; }
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct TokenPrivileges { public uint Count; public Luid Id; public uint Attributes; }
  [DllImport("wtsapi32.dll",SetLastError=true)] static extern bool WTSEnumerateSessionsW(IntPtr server,int reserved,int version,out IntPtr data,out int count);
  [DllImport("wtsapi32.dll",SetLastError=true)] static extern bool WTSQuerySessionInformationW(IntPtr server,int id,int info,out IntPtr buffer,out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr data);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LookupPrivilegeValue(string system,string name,out Luid id);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token,bool disable,ref TokenPrivileges value,int size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("powrprof.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.U1)] static extern bool GetPwrCapabilities([Out] byte[] data);
  [DllImport("powrprof.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.U1)] static extern bool SetSuspendState([MarshalAs(UnmanagedType.U1)] bool hibernate,[MarshalAs(UnmanagedType.U1)] bool force,[MarshalAs(UnmanagedType.U1)] bool disableWake);
  static string Text(int session,int kind) {
   IntPtr value; int bytes;
   if(!WTSQuerySessionInformationW(IntPtr.Zero,session,kind,out value,out bytes))throw new Win32Exception();
   try {return value==IntPtr.Zero?"":Marshal.PtrToStringUni(value)??"";} finally {WTSFreeMemory(value);}
  }
  static bool EnableSleepPrivilege() {
   IntPtr token;
   if(!OpenProcessToken(GetCurrentProcess(),0x28,out token))return false;
   try {
    Luid id;if(!LookupPrivilegeValue(null,"SeShutdownPrivilege",out id))return false;
    TokenPrivileges value=new TokenPrivileges{Count=1,Id=id,Attributes=2};
    return AdjustTokenPrivileges(token,false,ref value,0,IntPtr.Zero,IntPtr.Zero)&&Marshal.GetLastWin32Error()==0;
   } finally {CloseHandle(token);}
  }
  public static PowerSnapshot Inspect(string excludedUser) {
   WindowsIdentity identity=WindowsIdentity.GetCurrent();
   string excludedSid;
   try {excludedSid=String.Equals(excludedUser,identity.Name,StringComparison.OrdinalIgnoreCase)?identity.User.Value:((SecurityIdentifier)new NTAccount(excludedUser).Translate(typeof(SecurityIdentifier))).Value;}
   catch {throw new InvalidOperationException("EXCLUDED_ACCOUNT_NOT_FOUND");}
   List<PowerSession> sessions=new List<PowerSession>();
   IntPtr data;int count;
   if(!WTSEnumerateSessionsW(IntPtr.Zero,0,1,out data,out count))throw new Win32Exception();
   try {
    int size=Marshal.SizeOf(typeof(SessionInfo));
    string[] states={"active","connected","connect_query","shadow","disconnected","idle","listen","reset","down","init"};
    for(int i=0;i<count;i++) {
     SessionInfo session=(SessionInfo)Marshal.PtrToStructure(IntPtr.Add(data,i*size),typeof(SessionInfo));
     if(session.Id==0||session.State==6)continue;
     string user=Text(session.Id,5),domain=Text(session.Id,7);
     if(String.IsNullOrEmpty(user)&&(session.State==7||session.State==8||session.State==9))continue;
     string account=String.IsNullOrEmpty(user)?null:(String.IsNullOrEmpty(domain)?user:domain+"\\"+user);
     string sid=null;
     if(account!=null) {try {sid=String.Equals(account,identity.Name,StringComparison.OrdinalIgnoreCase)?identity.User.Value:((SecurityIdentifier)new NTAccount(account).Translate(typeof(SecurityIdentifier))).Value;}catch {}}
     double? idle=null;
     // An excluded account need not expose its idle information. Every other failure blocks sleep.
     if(sid!=excludedSid) {
      IntPtr info;int bytes;
      if(!WTSQuerySessionInformationW(IntPtr.Zero,session.Id,25,out info,out bytes))throw new Win32Exception();
      try {
       if(bytes<Marshal.SizeOf(typeof(InfoEx)))throw new InvalidOperationException("SESSION_DATA_UNAVAILABLE");
       InfoEx details=(InfoEx)Marshal.PtrToStructure(info,typeof(InfoEx));
       if(details.Level!=1||details.Data.SessionId!=(uint)session.Id)throw new InvalidOperationException("SESSION_DATA_UNAVAILABLE");
       if(details.Data.LastInputTime>0&&details.Data.CurrentTime>=details.Data.LastInputTime)idle=Math.Floor((details.Data.CurrentTime-details.Data.LastInputTime)/10000000.0);
      } finally {WTSFreeMemory(info);}
     }
     sessions.Add(new PowerSession{id=session.Id,account=account,account_sid=sid,state=session.State>=0&&session.State<states.Length?states[session.State]:"unknown",idle_seconds=idle});
    }
   } finally {WTSFreeMemory(data);}
   // SYSTEM_POWER_CAPABILITIES starts with BYTE fields, including S1/S2/S3 at 3/4/5 and AoAc at 25.
   // Allocate more than the complete native structure; no locale-dependent powercfg output parsing.
   byte[] capabilities=new byte[256];
   if(!GetPwrCapabilities(capabilities))throw new Win32Exception();
   return new PowerSnapshot{complete=true,api_account=identity.Name,excluded_sid=excludedSid,sessions=sessions.ToArray(),
    suspend_supported=capabilities[3]!=0||capabilities[4]!=0||capabilities[5]!=0||capabilities[25]!=0,suspend_privilege=EnableSleepPrivilege()};
  }
  public static string BlockReason(PowerSnapshot snapshot,int idleSeconds) {
   if(!snapshot.complete)return "SESSION_DATA_UNAVAILABLE";
   foreach(PowerSession session in snapshot.sessions) {
    if(session.account_sid==snapshot.excluded_sid)continue;
    if(session.account==null||!session.idle_seconds.HasValue||session.idle_seconds.Value<0||!(session.state=="active"||session.state=="connected"||session.state=="connect_query"||session.state=="shadow"||session.state=="disconnected"||session.state=="idle"))return "SESSION_DATA_UNAVAILABLE";
    if(session.idle_seconds.Value<=idleSeconds)return "USER_ACTIVE";
   }
   if(!snapshot.suspend_supported)return "SUSPEND_UNSUPPORTED";
   if(!snapshot.suspend_privilege)return "POWER_PRIVILEGE_MISSING";
   return null;
  }
  public static string SuspendIfIdle(string user,int idleSeconds,int ownerPid) {
   PowerSnapshot fresh=Inspect(user);
   string reason=BlockReason(fresh,idleSeconds);if(reason!=null)return reason;
   try {if(Process.GetProcessById(ownerPid).HasExited)return "POWER_OWNER_GONE";}catch {return "POWER_OWNER_GONE";}
   // Sleep (not shutdown or hibernation), preserve wake events. There is no forced logout.
   if(!SetSuspendState(false,false,false))throw new Win32Exception();
   return null;
  }
 }
}
