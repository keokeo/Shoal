; Stop Shoal main window and any orphaned bundled Node runtime before installing or uninstalling.
!macro StopBundledShoal scope
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    nsis_tauri_utils::StrReplace "$(appRunning)" "{{product_name}}" "${PRODUCTNAME}"
    Pop $R1
    nsis_tauri_utils::StrReplace "$(appRunningOkKill)" "{{product_name}}" "${PRODUCTNAME}"
    Pop $R2
    nsis_tauri_utils::StrReplace "$(failedToKillApp)" "{{product_name}}" "${PRODUCTNAME}"
    Pop $R3

    !insertmacro RestartManager_StartSession $R0
    ${If} $R0 != ""
      !insertmacro RestartManager_RegisterFile $R0 "$INSTDIR\${MAINBINARYNAME}.exe"
      ${If} $0 = 0
        System::Call 'RSTRTMGR::RmGetList(p R0, *i .r1, *i .r2, p 0, *i .r3) i .r0'
        ${If} $0 = ${ERROR_MORE_DATA}
          IfSilent shoal_${scope}_kill 0
          ${IfThen} $PassiveMode != 1 ${|} MessageBox MB_OKCANCEL $R2 IDOK shoal_${scope}_kill IDCANCEL shoal_${scope}_cancel ${|}
          shoal_${scope}_kill:
            System::Call 'RSTRTMGR::RmShutdown(p R0, i ${RmForceShutdown}, p 0) i .r0'
            ${If} $0 = 0
              Sleep 300
              Goto shoal_${scope}_done
            ${Else}
              IfSilent shoal_${scope}_silent shoal_${scope}_ui
              shoal_${scope}_silent:
                System::Call 'kernel32::AttachConsole(i -1)i.r0'
                ${If} $0 <> 0
                  System::Call 'kernel32::GetStdHandle(i -11)i.r0'
                  System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)'
                  FileWrite $0 "$R1$\n"
                ${EndIf}
                !insertmacro RestartManager_EndSession $R0
                Abort
              shoal_${scope}_ui:
                !insertmacro RestartManager_EndSession $R0
                Abort $R3
            ${EndIf}
          shoal_${scope}_cancel:
            !insertmacro RestartManager_EndSession $R0
            Abort $R1
          shoal_${scope}_done:
        ${EndIf}
      ${EndIf}
      !insertmacro RestartManager_EndSession $R0
    ${EndIf}
  ${EndIf}

  ${If} ${FileExists} "$INSTDIR\app\node.exe"
  ${OrIf} ${FileExists} "$INSTDIR\app\node_modules\node-pty\prebuilds\win32-x64\conpty.node"
    !insertmacro RestartManager_StartSession $R0
    ${If} $R0 != ""
      StrCpy $R1 0
      ${If} ${FileExists} "$INSTDIR\app\node.exe"
        !insertmacro RestartManager_RegisterFile $R0 "$INSTDIR\app\node.exe"
        ${If} $0 = 0
          StrCpy $R1 1
        ${EndIf}
      ${EndIf}
      ${If} ${FileExists} "$INSTDIR\app\node_modules\node-pty\prebuilds\win32-x64\conpty.node"
        !insertmacro RestartManager_RegisterFile $R0 "$INSTDIR\app\node_modules\node-pty\prebuilds\win32-x64\conpty.node"
        ${If} $0 = 0
          StrCpy $R1 1
        ${EndIf}
      ${EndIf}
      ${If} $R1 = 1
        System::Call 'RSTRTMGR::RmGetList(p R0, *i .r1, *i .r2, p 0, *i .r3) i .r0'
        ${If} $0 = ${ERROR_MORE_DATA}
          System::Call 'RSTRTMGR::RmShutdown(p R0, i ${RmForceShutdown}, p 0) i .r0'
          Sleep 300
        ${EndIf}
      ${EndIf}
      !insertmacro RestartManager_EndSession $R0
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopBundledShoal install
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopBundledShoal uninstall
!macroend
