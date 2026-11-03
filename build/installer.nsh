; Windows: "Mit Convertline umwandeln" im Kontextmenü von Videos, Musik und Bildern.
; Standard-Apps und "Öffnen mit" fasst Convertline nie an.
; SHCTX = HKCU bei "Nur für mich" (Standard), HKLM nur bei "Für alle Benutzer".

!define CONVERTLINE_VERB "shell\Convertline"

!macro convertlineAddVerb TYPE
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${TYPE}\${CONVERTLINE_VERB}" "" "$1"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${TYPE}\${CONVERTLINE_VERB}" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${TYPE}\${CONVERTLINE_VERB}" "MultiSelectModel" "Player"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${TYPE}\${CONVERTLINE_VERB}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customInstall
  Push $1
  StrCpy $1 "Convert with Convertline"
  ${If} $LANGUAGE == 1031
    StrCpy $1 "Mit Convertline umwandeln"
  ${EndIf}
  !insertmacro convertlineAddVerb "video"
  !insertmacro convertlineAddVerb "audio"
  !insertmacro convertlineAddVerb "image"
  Pop $1
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\video\${CONVERTLINE_VERB}"
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\audio\${CONVERTLINE_VERB}"
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\image\${CONVERTLINE_VERB}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
