Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
command = "cmd.exe /d /s /c """ & root & "\start-remotecodex.bat"""

shell.Run command, 0, False
