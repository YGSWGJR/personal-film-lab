; ============================================================================
; 个人拉片工作台 安装器定制
; 交付目录结构：Setup 与 个人拉片工作台-<版本>-local-ai.7z 同目录；
; 7z 档案带 local-ai\ 根前缀，解压落位 $INSTDIR\resources\local-ai。
;
; S46 改进（0.5.2-alpha.3）：
;   1. AI 资源跨安装复用：customInit（.onInit 内，GUI/静默都执行）在旧版卸载器
;      删除旧目录之前，把已装完整的 resources\local-ai 整目录 Rename 到同卷保留
;      目录 lapian-local-ai-keep（同卷 Rename 瞬时完成，旧卸载器删不到它）；
;      customInstall 再 Rename 回新目录，跳过 12GB / 65,363 文件解压。
;      升级 / 重装从「先删 12GB 再重解 12GB」降为分钟级。
;      若用户中途取消安装，AI 资源留在保留目录，下次运行 Setup 自愈（认领 + 搬回）。
;   2. 解压进度可见：Nsis7z::Extract（electron-builder 自带 nsis7z 插件，
;      与模板 extractAppPackage.nsh 同款）替代 7zr + nsExec——不再阻塞 UI、
;      INSTFILES 进度条真实走动；并用 SetDetailsPrint listonly 恢复被模板
;      SetDetailsPrint none 吞掉的阶段提示。
;   3. 解压成功后写 marker .ai-payload-version，记录载荷代次（${VERSION}）。
;   4. customRemoveFiles：卸载器直接 RMDir /r $INSTDIR，替换模板默认的
;      atomicRMDir（逐文件 Rename 到 $PLUGINSDIR——%TEMP% 卷；安装目录与 TEMP
;      跨卷时升级会直接中止 "Can't rename"）。CHECK_APP_RUNNING 已确保应用未运行。
;
; 已知边界（如实记录）：全新安装（本机无任何旧 AI 资源）时解压无法跳过，速度
; 改善 = 真实进度 + 阶段提示 + 预期管理；用户中途取消且事后手动删除保留目录的
; 组合属极端情况，重装 Setup 即可恢复完整功能。
; ============================================================================

!ifndef LAPIAN_INSTALLER_NSH_INCLUDED
!define LAPIAN_INSTALLER_NSH_INCLUDED

; 仅安装侧编译（BUILD_UNINSTALLER 中间编译里 customInit/customInstall 不参与，
; 变量会被 NSIS 报 6001 且 electron-builder 把警告当错误）
!ifndef BUILD_UNINSTALLER
Var lapianAiKeepDir
Var lapianAiTarget
!endif

!macro lapianAiIsReady DIR RETVAR
  ; 完整性三件套，与 scripts/prepare-local-ai.ps1 Test-LocalAiReady 一致
  StrCpy ${RETVAR} "0"
  ${If} ${FileExists} "${DIR}\runtime\python_embeded\python.exe"
  ${AndIf} ${FileExists} "${DIR}\ComfyUI\main.py"
  ${AndIf} ${FileExists} "${DIR}\models\text_encoders\qwen3vl_8b_w4a8.safetensors"
    StrCpy ${RETVAR} "1"
  ${EndIf}
!macroend

!macro lapianAiRescue OLDROOT
  ; OLDROOT = 旧安装目录。保留目录固定命名在旧目录父目录下（与旧目录同卷，
  ; Rename 瞬时完成），且在 $INSTDIR 之外，旧卸载器 RMDir /r 删不到。
  Push $R7
  Push $R8
  Push $R9
  ${GetParent} "${OLDROOT}" $R9
  StrCpy $R8 "$R9\lapian-local-ai-keep"
  ${If} ${FileExists} "$R8"
    ; 上次安装中途取消留下的保留目录：完整则直接认领，不完整则清掉
    !insertmacro lapianAiIsReady "$R8" $R7
    ${If} $R7 == "1"
      StrCpy $lapianAiKeepDir "$R8"
    ${Else}
      RMDir /r "$R8"
    ${EndIf}
  ${ElseIf} ${FileExists} "${OLDROOT}\resources\local-ai"
    !insertmacro lapianAiIsReady "${OLDROOT}\resources\local-ai" $R7
    ${If} $R7 == "1"
      Rename "${OLDROOT}\resources\local-ai" "$R8"
      ${If} ${FileExists} "$R8\runtime\python_embeded\python.exe"
        StrCpy $lapianAiKeepDir "$R8"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
!macroend

!macro customInit
  ; 先于 installSection 的 uninstallOldVersion 执行：把旧目录里的 AI 资源抢救出来。
  ; initMultiUser 已把 $INSTDIR 设为上次 per-user 安装目录（无记录则为默认值）；
  ; per-machine 旧记录另从 HKLM 读一次。
  StrCpy $lapianAiKeepDir ""
  !insertmacro lapianAiRescue "$INSTDIR"
  ${If} $lapianAiKeepDir == ""
    ReadRegStr $R9 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R9 != ""
      !insertmacro lapianAiRescue "$R9"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  ; 模板 installSection 开头 SetDetailsPrint none 会吞掉 DetailPrint，这里恢复列表输出
  SetDetailsPrint listonly

  StrCpy $lapianAiTarget "$INSTDIR\resources\local-ai"

  ; 1) 升级/重装：把 customInit 抢救出的 AI 资源搬回新目录（同卷 Rename 瞬时完成）
  ${If} $lapianAiKeepDir != ""
    CreateDirectory "$INSTDIR\resources"
    ; installApplicationFiles 已把 extraResources 的 local-ai\bridge 装进目标目录，
    ; 而 NSIS 无法 Rename 到已存在的目录（S46 实测踩坑：复用退化成全量重解）。
    ; 保留目录是旧安装的完整 local-ai（同样含 bridge），先清空目标再整体搬回。
    ${If} ${FileExists} "$lapianAiTarget"
      RMDir /r "$lapianAiTarget"
    ${EndIf}
    Rename "$lapianAiKeepDir" "$lapianAiTarget"
    !insertmacro lapianAiIsReady "$lapianAiTarget" $R7
    ${If} $R7 == "1"
      DetailPrint "已复用旧安装的本地 AI 资源（约 12GB），跳过解压。"
      Goto lapian_ai_write_marker
    ${Else}
      ; 搬回失败（多半是安装目录改到了别的盘）：清残留，走全新解压；
      ; 保留目录若仍存在则留给下次安装认领
      DetailPrint "无法复用旧 AI 资源（跨盘搬移失败），本次将重新解压。"
      RMDir /r "$lapianAiTarget"
      StrCpy $lapianAiKeepDir ""
    ${EndIf}
  ${EndIf}

  ; 2) 目标目录已完整（旧卸载器未触及 AI 的场景）→ 直接跳过
  !insertmacro lapianAiIsReady "$lapianAiTarget" $R7
  ${If} $R7 == "1"
    DetailPrint "检测到本地 AI 资源已存在，跳过解压。"
    Goto lapian_ai_write_marker
  ${EndIf}

  ; 3) 查找离线 AI 包：精确版本名优先，回退 $EXEDIR 下任意 *-local-ai.7z
  StrCpy $R0 "$EXEDIR\个人拉片工作台-${VERSION}-local-ai.7z"
  ${If} ${FileExists} "$R0"
    Goto lapian_ai_run
  ${EndIf}
  FindFirst $R1 $R2 "$EXEDIR\*-local-ai.7z"
  ${If} $R2 != ""
    StrCpy $R0 "$EXEDIR\$R2"
    FindClose $R1
    Goto lapian_ai_run
  ${EndIf}
  FindClose $R1
  ${If} ${Silent}
    Goto lapian_ai_skip
  ${EndIf}
  MessageBox MB_YESNO|MB_ICONQUESTION "未找到本地 AI 资源包：$\r$\n$R0$\r$\n$\r$\n缺少该文件时只能安装应用主体，本地镜头理解不可用。是否继续仅安装主体？" IDYES lapian_ai_skip IDNO lapian_ai_abort
  lapian_ai_abort:
    Abort

  lapian_ai_run:
    DetailPrint "正在安装本地 AI 运行环境与 Qwen3-VL 模型（约 12GB，65,363 个文件）..."
    DetailPrint "进度条会持续走动；机械硬盘上可能需要 10-40 分钟，请耐心等待，不要关闭安装窗口。"
    Push $OUTDIR
    CreateDirectory "$INSTDIR\resources"
    SetOutPath "$INSTDIR\resources"
    Nsis7z::Extract "$R0"
    Pop $R9
    SetOutPath $R9
    ; 解压结果以三件套实存为准（与插件返回值约定解耦）
    !insertmacro lapianAiIsReady "$lapianAiTarget" $R7
    ${If} $R7 != "1"
      ${If} ${Silent}
        Abort
      ${EndIf}
      MessageBox MB_ICONSTOP|MB_OK "本地 AI 资源包解压失败。$\r$\n请确认安装目录有足够空间（建议预留 30GB 以上），并重新运行安装程序。"
      Abort
    ${EndIf}

  lapian_ai_write_marker:
    FileOpen $R5 "$lapianAiTarget\.ai-payload-version" w
    ${If} $R5 != ""
      FileWrite $R5 "${VERSION}"
      FileClose $R5
    ${EndIf}
    DetailPrint "本地 AI 运行环境就绪。"

  lapian_ai_skip:
    SetOutPath "$INSTDIR"
!macroend

!macro customRemoveFiles
  ; 替换模板默认删除段（uninstaller.nsh）：模板在 --updated 时用 atomicRMDir 把
  ; $INSTDIR 逐文件 Rename 到 $PLUGINSDIR\old-install（%TEMP% 卷），安装目录与
  ; TEMP 跨卷时必败并中止升级。CHECK_APP_RUNNING 已确保应用未运行，直接递归删除；
  ; customInit 抢救出的 lapian-local-ai-keep 在 $INSTDIR 之外，不受影响。
  SetOutPath $TEMP
  RMDir /r $INSTDIR
!macroend

!endif ; LAPIAN_INSTALLER_NSH_INCLUDED
