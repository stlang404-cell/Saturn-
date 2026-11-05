; Installs the bundled local model from the "models" folder that ships next to the
; installer. (NSIS cannot embed payloads larger than ~2 GB; the model is ~2.5 GB.)
!macro customInstall
  IfFileExists "$EXEDIR\models\*.gguf" 0 saturn_no_model
    CreateDirectory "$INSTDIR\resources\models"
    DetailPrint "Installing the SATURN language model (this can take a minute)..."
    CopyFiles /SILENT "$EXEDIR\models\*.gguf" "$INSTDIR\resources\models"
    Goto saturn_model_done
  saturn_no_model:
    MessageBox MB_OK|MB_ICONINFORMATION "No model folder was found next to the installer. SATURN will run with its offline parser until a model file (.gguf) is placed in $INSTDIR\resources\models."
  saturn_model_done:
!macroend

!macro customUnInstall
  RMDir /r "$INSTDIR\resources\models"
!macroend
