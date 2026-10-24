; Primo avvio (22/10/2026, VM da «vergine»): Windows controlla un eseguibile nuovo e non firmato prima di farlo partire,
; fino a un minuto e mezzo dopo «Chiudi» senza nessun segno, e il tester crede che VISIONE non si apra. Qui lo si avvia
; una volta, mentre la barra dell'installatore è visibile e dice cosa succede: VISIONE con `--visione-precheck` esce
; subito (src/main/index.ts), e il controllo di Windows è già fatto quando si preme «Esegui VISIONE».
; L'installatore di electron-builder spegne le righe di dettaglio (`SetDetailsPrint none` in installSection.nsh; VM
; beta.30, 23/10/2026: la barra restava ferma per 50 s senza testo): qui si accende il testo solo per questa riga e lo
; si rispegne prima di ExecWait, che altrimenti la sostituisce con «Esecuzione di: …VISIONE.exe --visione-precheck»
; (VM beta.31). Alla fine resta spento, come prima.
!macro customInstall
  SetDetailsPrint textonly
  ${if} $LANGUAGE == 1040
    DetailPrint "Windows controlla il programma nuovo: può volerci fino a un minuto..."
  ${else}
    DetailPrint "Windows is checking the new program: this can take up to a minute..."
  ${endif}
  SetDetailsPrint none
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --visione-precheck'
!macroend

; Aggiornamento con VISIONE aperta (VM beta.31, 23/10/2026): il controllo standard la chiudeva di forza e al riavvio
; compariva un errore rosso. Prima le si chiede di chiudersi in ordine come quando si chiude la finestra (WM_CLOSE alla
; finestra «VISIONE» di Electron: l'app si ferma col core, in ogni versione già installata) e si aspetta fino a 20 s;
; solo se è ancora aperta si passa al controllo standard (avviso e chiusura forzata). Non si avvia l'eseguibile
; installato: una versione vecchia, avviata con un'opzione che non conosce, si portava davanti all'installatore (beta.32).
; Con customCheckAppRunning electron-builder non include getProcessInfo.nsh né dichiara $pid, che il controllo standard
; usa (allowOnlyOneInstallerInstance.nsh): li si porta qui, una volta sola.
!ifndef GetProcessInfo
  !include "getProcessInfo.nsh"
  Var pid
!endif
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    SetDetailsPrint textonly
    ${if} $LANGUAGE == 1040
      DetailPrint "Chiudo VISIONE in ordine per aggiornarla..."
    ${else}
      DetailPrint "Closing VISIONE properly to update it..."
    ${endif}
    SetDetailsPrint none
    StrCpy $R1 0
    ${Do}
      ; WM_CLOSE (0x10) alla finestra principale di VISIONE, ripetuto finché il processo non c'è più.
      FindWindow $R2 "Chrome_WidgetWin_1" "VISIONE"
      ${If} $R2 != 0
        SendMessage $R2 0x10 0 0 /TIMEOUT=2000
      ${EndIf}
      Sleep 1000
      IntOp $R1 $R1 + 1
      !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
      ${If} $R0 != 0
        ${ExitDo}
      ${EndIf}
    ${LoopUntil} $R1 >= 20
  ${endif}
  !insertmacro _CHECK_APP_RUNNING
!macroend
