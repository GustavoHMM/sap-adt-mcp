; Hooks for the electron-builder NSIS installer.

; Uninstall (never on updates): take this installation out of Claude Desktop and
; Claude Code (with backups) and remove the runtime copies. Profiles and passwords
; are kept unless the person chooses to delete them; silent uninstalls keep them.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    StrCpy $0 ""
    IfSilent cleanup
    ${if} $LANGUAGE == 1046
      MessageBox MB_YESNO|MB_ICONQUESTION "Apagar também os perfis do SAP e as senhas guardadas neste computador?$\r$\n$\r$\nEscolha Não para mantê-los caso instale o app de novo." /SD IDNO IDNO cleanup
    ${else}
      MessageBox MB_YESNO|MB_ICONQUESTION "Also delete the SAP profiles and the passwords saved on this computer?$\r$\n$\r$\nChoose No to keep them in case you install the app again." /SD IDNO IDNO cleanup
    ${endIf}
    StrCpy $0 "--purge"
    cleanup:
    ExecWait '"$INSTDIR\resources\cli\abap-adt-mcp.exe" uninstall-cleanup $0'
  ${endIf}
!macroend
