!macro customInstall
  IfFileExists "$EXEDIR\个人拉片工作台-0.1.9-local-ai.7z" local_ai_found
    IfSilent local_ai_skip
    MessageBox MB_YESNO|MB_ICONQUESTION "未找到本地 AI 资源包：$\r$\n个人拉片工作台-0.1.9-local-ai.7z$\r$\n$\r$\n缺少该文件时只能安装应用主体，本地镜头理解不可用。是否继续仅安装主体？" IDYES local_ai_skip IDNO local_ai_abort

  local_ai_abort:
    Abort

  local_ai_found:
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "${BUILD_RESOURCES_DIR}\7zr.exe"
    DetailPrint "正在安装本地 AI 运行环境与 Qwen3-VL 模型..."
    nsExec::ExecToLog '"$PLUGINSDIR\7zr.exe" x "$EXEDIR\个人拉片工作台-0.1.9-local-ai.7z" -o"$INSTDIR\resources" -y -aoa'
    Pop $0
    StrCmp $0 "0" local_ai_installed
    MessageBox MB_ICONSTOP|MB_OK "本地 AI 资源包解压失败（退出码：$0）。$\r$\n请确认安装目录有足够空间，并重新运行安装程序。"
    Abort

  local_ai_installed:
    DetailPrint "本地 AI 运行环境安装完成。"
    SetOutPath "$INSTDIR"

  local_ai_skip:
!macroend
