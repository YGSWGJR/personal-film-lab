!macro customInstall
  ; v0.2.0 修复：local-ai 资源包文件名跟随版本号，避免升版后写死旧版本名找不到文件。
  ; 查找顺序：个人拉片工作台-<版本>-local-ai.7z → $EXEDIR 下任意 *-local-ai.7z → 提示后跳过。
  StrCpy $R0 "$EXEDIR\个人拉片工作台-${PRODUCT_VERSION}-local-ai.7z"
  IfFileExists $R0 local_ai_run
    FindFirst $R1 $R2 "$EXEDIR\*-local-ai.7z"
    StrCmp $R2 "" local_ai_notfound local_ai_found_glob

  local_ai_found_glob:
    StrCpy $R0 "$EXEDIR\$R2"
    FindClose $R1
    Goto local_ai_run

  local_ai_notfound:
    FindClose $R1
    IfSilent local_ai_skip
    MessageBox MB_YESNO|MB_ICONQUESTION "未找到本地 AI 资源包：$\r$\n$R0$\r$\n$\r$\n缺少该文件时只能安装应用主体，本地镜头理解不可用。是否继续仅安装主体？" IDYES local_ai_skip IDNO local_ai_abort

  local_ai_abort:
    Abort

  local_ai_run:
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "${BUILD_RESOURCES_DIR}\7zr.exe"
    DetailPrint "正在安装本地 AI 运行环境与 Qwen3-VL 模型..."
    nsExec::ExecToLog '"$PLUGINSDIR\7zr.exe" x "$R0" -o"$INSTDIR\resources" -y -aoa -bd -bb0'
    Pop $0
    StrCmp $0 "0" local_ai_installed local_ai_extract_failed
    Goto local_ai_extract_failed

  local_ai_extract_failed:
    IfSilent local_ai_silent_fail
    MessageBox MB_ICONSTOP|MB_OK "本地 AI 资源包解压失败（退出码：$0）。$\r$\n请确认安装目录有足够空间，并重新运行安装程序。"
    Abort

  local_ai_silent_fail:
    Abort

  local_ai_installed:
    DetailPrint "本地 AI 运行环境安装完成。"
    SetOutPath "$INSTDIR"

  local_ai_skip:
!macroend
