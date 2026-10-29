' Launch bridge-guard.ps1 that sits in the same folder as this file.
' No absolute paths, no non-ASCII text: works after moving the repo anywhere.
Dim fso, sh, here, ps1
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\bridge-guard.ps1"
If Not fso.FileExists(ps1) Then
  MsgBox "bridge-guard.ps1 not found next to this file:" & vbCrLf & ps1, 16, "QQ DSH Bridge"
  WScript.Quit 1
End If
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False