; ============================================================================
; 个人拉片工作台 独立卸载工具（NSIS 原生版，S46 / 0.5.2-alpha.3 起）
; 替代原 PyInstaller 版（scripts/uninstall/uninstall_tool.py 保留作参考与 QA）：
;   - 原生 PE、体积几百 KB、内嵌应用图标与中文版本资源，Explorer 显示正常；
;   - 行为对齐 uninstall_tool.py：在 HKCU/HKLM × 注册表 64/32 视图共 4 组合里查
;     Uninstall\a9c108e5-343a-59b6-843d-cabcec74a65f，DisplayName ∈ {个人拉片工作台,
;     个人拉片工作台 <版本>} 且 DisplayVersion 精确等于工具版本，UninstallString
;     形如 "<...\uninstall 个人拉片工作台.exe> <scope>" 且卸载器同目录存在主程序
;     → 记为一次匹配；仅当恰好一次匹配才执行；
;   - 用法：（无参数）GUI 确认后执行卸载器；/S 静默；/DRYRUN /REPORT=<path> 写
;     JSON 报告（Unicode 构建输出 UTF-16LE+BOM，QA 用 PowerShell Get-Content 读）；
;   - 由 scripts/build-uninstall-tool.ps1 调 makensis 编译，CWD = 输出目录
;     （OutFile 相对 CWD 落盘）；图标硬编码绝对路径（同 PyInstaller spec 惯例）。
; ============================================================================

Unicode true
RequestExecutionLevel user

!define APP_NAME "个人拉片工作台"
!define TOOL_VERSION "0.5.2-alpha.3"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\a9c108e5-343a-59b6-843d-cabcec74a65f"

VIProductVersion "0.5.2.3"
VIAddVersionKey /LANG=2052 "FileDescription" "个人拉片工作台卸载工具"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Personal Film Lab"
VIAddVersionKey /LANG=2052 "FileVersion" "0.5.2.3"
VIAddVersionKey /LANG=2052 "ProductName" "个人拉片工作台"
VIAddVersionKey /LANG=2052 "ProductVersion" "${TOOL_VERSION}"
VIAddVersionKey /LANG=2052 "OriginalFilename" "个人拉片工作台卸载工具-${TOOL_VERSION}.exe"

Icon "G:\自我研发软件\自制软件\build\icon.ico"
OutFile "个人拉片工作台卸载工具-${TOOL_VERSION}.exe"

Var dryRun
Var reportPath
Var silentMode
Var matchCount
Var m1
Var m2
Var m3
Var m4
Var regName
Var regVer
Var regUninst

!include "LogicLib.nsh"
!include "FileFunc.nsh"

Function JsonEscape
  ; 栈顶入字符串 → 栈顶出 JSON 转义后的字符串（反斜杠成对、引号加反斜杠）
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  StrCpy $R3 ""
  StrLen $R4 $R0
  StrCpy $R1 0
  lapian_json_loop:
    ${If} $R1 >= $R4
      Goto lapian_json_done
    ${EndIf}
    StrCpy $R2 "$R0" 1 $R1
    ${If} $R2 == '\'
      StrCpy $R3 "$R3\\"
    ${ElseIf} $R2 == "$\""
      StrCpy $R3 "$R3$\""
    ${Else}
      StrCpy $R3 "$R3$R2"
    ${EndIf}
    IntOp $R1 $R1 + 1
    Goto lapian_json_loop
  lapian_json_done:
  StrCpy $R0 $R3
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd

Function TrimSpaces
  ; 栈顶入字符串 → 栈顶出去除首尾空格/制表符
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  StrLen $R3 $R0
  StrCpy $R1 0
  lapian_trim_left:
    ${If} $R1 >= $R3
      Goto lapian_trim_left_done
    ${EndIf}
    StrCpy $R2 "$R0" 1 $R1
    ${If} $R2 == " "
    ${OrIf} $R2 == "$\t"
      IntOp $R1 $R1 + 1
      Goto lapian_trim_left
    ${EndIf}
  lapian_trim_left_done:
  lapian_trim_right:
    ${If} $R3 <= $R1
      Goto lapian_trim_right_done
    ${EndIf}
    IntOp $R3 $R3 - 1
    StrCpy $R2 "$R0" 1 $R3
    ${If} $R2 == " "
    ${OrIf} $R2 == "$\t"
      Goto lapian_trim_right
    ${EndIf}
  lapian_trim_right_done:
  IntOp $R3 $R3 - $R1
  ${If} $R3 > 0
    IntOp $R3 $R3 + 1
    StrCpy $R0 "$R0" $R3 $R1
  ${Else}
    StrCpy $R0 ""
  ${EndIf}
  Pop $R3
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd

; 校验 $regName/$regVer/$regUninst（已读出的登记三元组），匹配则去重入库。
; 栈顶传 scope："/currentuser" 或 "/allusers"。
Function ValidateAndStore
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R9
  StrCpy $R1 "0"
  ; DisplayName ∈ {APP_NAME, APP_NAME+空格+版本}（StrCmp 大小写不敏感）
  ${If} $regName == "${APP_NAME}"
  ${OrIf} $regName == "${APP_NAME} ${TOOL_VERSION}"
    StrCpy $R1 "1"
  ${EndIf}
  ${If} $R1 != "1"
    Goto lapian_vas_done
  ${EndIf}
  ; DisplayVersion 精确等于工具版本
  ${If} $regVer != "${TOOL_VERSION}"
    Goto lapian_vas_done
  ${EndIf}
  ; UninstallString 必须形如 "<路径>" + 空白 + scope（+ 尾随空白）
  StrCpy $R2 "$regUninst" 1 0
  ${If} $R2 != "$\""
    Goto lapian_vas_done
  ${EndIf}
  StrLen $R3 $regUninst
  StrCpy $R4 ""            ; 闭引号下标
  StrCpy $R2 1             ; 从下标 1 起找
  lapian_vas_findquote:
    ${If} $R2 >= $R3
      Goto lapian_vas_quote_done
    ${EndIf}
    StrCpy $R5 "$regUninst" 1 $R2
    ${If} $R5 == "$\""
      StrCpy $R4 $R2
      Goto lapian_vas_quote_done
    ${EndIf}
    IntOp $R2 $R2 + 1
    Goto lapian_vas_findquote
  lapian_vas_quote_done:
  ${If} $R4 == ""
    Goto lapian_vas_done
  ${EndIf}
  ; 引号内 = 卸载器路径：索引 1 起共 $R4 - 1 个字符（$R4 本身是闭引号，不能带上）
  IntOp $R5 $R4 - 1
  StrCpy $R9 "$regUninst" $R5 1
  ${IfNot} ${FileExists} "$R9"
    Goto lapian_vas_done
  ${EndIf}
  ${GetFileName} "$R9" $R5
  ${If} $R5 != "uninstall ${APP_NAME}.exe"
    Goto lapian_vas_done
  ${EndIf}
  ${GetParent} "$R9" $R5
  ${IfNot} ${FileExists} "$R5\${APP_NAME}.exe"
    Goto lapian_vas_done
  ${EndIf}
  IntOp $R6 $R4 + 1
  StrCpy $R7 "$regUninst" "" $R6   ; 引号后剩余部分
  Push "$R7"
  Call TrimSpaces
  Pop $R7
  ${If} $R7 != "$R0"
    Goto lapian_vas_done
  ${EndIf}
  ; 去重入库（键 = "路径|scope"；组合上限 4 个）
  StrCpy $R6 "$R9|$R0"
  ${If} $R6 == "$m1"
  ${OrIf} $R6 == "$m2"
  ${OrIf} $R6 == "$m3"
  ${OrIf} $R6 == "$m4"
    Goto lapian_vas_done
  ${EndIf}
  IntOp $matchCount $matchCount + 1
  ${If} $matchCount == "1"
    StrCpy $m1 "$R6"
  ${ElseIf} $matchCount == "2"
    StrCpy $m2 "$R6"
  ${ElseIf} $matchCount == "3"
    StrCpy $m3 "$R6"
  ${ElseIf} $matchCount == "4"
    StrCpy $m4 "$R6"
  ${EndIf}
  lapian_vas_done:
  Pop $R9
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

; 在当前注册表视图下读 HKCU 与 HKLM 两处登记并尝试入库
Function TryRegView
  ReadRegStr $regName HKCU "${UNINST_KEY}" "DisplayName"
  ReadRegStr $regVer HKCU "${UNINST_KEY}" "DisplayVersion"
  ReadRegStr $regUninst HKCU "${UNINST_KEY}" "UninstallString"
  ${If} $regName != ""
    Push "/currentuser"
    Call ValidateAndStore
  ${EndIf}
  ReadRegStr $regName HKLM "${UNINST_KEY}" "DisplayName"
  ReadRegStr $regVer HKLM "${UNINST_KEY}" "DisplayVersion"
  ReadRegStr $regUninst HKLM "${UNINST_KEY}" "UninstallString"
  ${If} $regName != ""
    Push "/allusers"
    Call ValidateAndStore
  ${EndIf}
FunctionEnd

Function FindMatches
  StrCpy $matchCount "0"
  StrCpy $m1 ""
  StrCpy $m2 ""
  StrCpy $m3 ""
  StrCpy $m4 ""
  SetRegView 64
  Call TryRegView
  SetRegView 32
  Call TryRegView
  SetRegView lastused
FunctionEnd

Function ParseArgs
  StrCpy $dryRun "0"
  StrCpy $reportPath ""
  StrCpy $silentMode "0"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} "$R0" "/DRYRUN" $R1
  ${IfNot} ${Errors}
    StrCpy $dryRun "1"
  ${EndIf}
  ClearErrors
  ${GetOptions} "$R0" "/REPORT=" $R1
  ${IfNot} ${Errors}
    StrCpy $reportPath "$R1"
    StrCpy $R2 "$R1" 1 0
    ${If} $R2 == "$\""
      StrLen $R3 "$R1"
      IntOp $R3 $R3 - 2
      ${If} $R3 > 0
        IntOp $R3 $R3 + 1
        StrCpy $reportPath "$R1" $R3 1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors
  ${GetOptions} "$R0" "/S" $R1
  ${IfNot} ${Errors}
    StrCpy $silentMode "1"
  ${EndIf}
  ClearErrors
FunctionEnd

Function WriteReport
  ; 输出与 Python 版同形（json.dumps indent=2）：
  ; { "version": ..., "matchingUninstallers": [卸载器路径...], "dryRun": true }
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  ; 报告父目录不存在时先创建（避免静默失败）
  ${GetParent} "$reportPath" $R4
  ${If} $R4 != ""
    CreateDirectory "$R4"
  ${EndIf}
  FileOpen $R0 "$reportPath" w
  ${If} $R0 == ""
    Goto lapian_report_done
  ${EndIf}
  FileWrite $R0 "{$\r$\n"
  FileWrite $R0 "  $\"version$\": $\"${TOOL_VERSION}$\",$\r$\n"
  ; matchCount 为纯 ASCII，规避 NSIS FileWrite 按 ANSI 代码页写中文路径的编码限制
  FileWrite $R0 "  $\"matchCount$\": $matchCount,$\r$\n"
  FileWrite $R0 "  $\"matchingUninstallers$\": ["
  StrCpy $R1 "1"
  lapian_report_items:
    ${If} $R1 > $matchCount
      Goto lapian_report_items_done
    ${EndIf}
    ${If} $R1 == "1"
      StrCpy $R2 "$m1"
    ${ElseIf} $R1 == "2"
      StrCpy $R2 "$m2"
    ${ElseIf} $R1 == "3"
      StrCpy $R2 "$m3"
    ${Else}
      StrCpy $R2 "$m4"
    ${EndIf}
    ; R2 = "路径|scope" → 最后一个 | 之前是路径
    StrLen $R3 "$R2"
    StrCpy $R4 "0"
    StrCpy $R5 ""
    lapian_report_findbar:
      ${If} $R4 >= $R3
        Goto lapian_report_bar_done
      ${EndIf}
      StrCpy $R6 "$R2" 1 $R4
      ${If} $R6 == "|"
        StrCpy $R5 "$R4"
      ${EndIf}
      IntOp $R4 $R4 + 1
      Goto lapian_report_findbar
    lapian_report_bar_done:
    ${If} $R5 == ""
      StrCpy $R6 "$R2"
    ${Else}
      StrCpy $R6 "$R2" $R5 0
    ${EndIf}
    Push "$R6"
    Call JsonEscape
    Pop $R6
    ${If} $R1 > "1"
      FileWrite $R0 ",$\r$\n    "
    ${Else}
      FileWrite $R0 "$\r$\n    "
    ${EndIf}
    FileWrite $R0 "$\"$R6$\""
    IntOp $R1 $R1 + 1
    Goto lapian_report_items
  lapian_report_items_done:
  ${If} $matchCount == "0"
    FileWrite $R0 "]"
  ${Else}
    FileWrite $R0 "$\r$\n  ]"
  ${EndIf}
  FileWrite $R0 ",$\r$\n  $\"dryRun$\": true$\r$\n}"
  FileClose $R0
  lapian_report_done:
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

Section ""
  Call ParseArgs
  Call FindMatches
  ${If} $dryRun == "1"
    Call WriteReport
    SetErrorLevel 0
    Quit
  ${EndIf}
  ${If} $matchCount != "1"
    ${If} $silentMode == "0"
      MessageBox MB_OK|MB_ICONINFORMATION "需要找到唯一的 ${APP_NAME} ${TOOL_VERSION} 安装记录。请在 Windows 的「已安装的应用」中核对版本。"
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
  ; 恰好一次匹配（入库顺序保证在 $m1）：拆 "路径|scope"
  StrLen $R0 "$m1"
  StrCpy $R1 0
  StrCpy $R2 ""
  lapian_main_findbar:
    ${If} $R1 >= $R0
      Goto lapian_main_bar_done
    ${EndIf}
    StrCpy $R3 "$m1" 1 $R1
    ${If} $R3 == "|"
      StrCpy $R2 $R1
    ${EndIf}
    IntOp $R1 $R1 + 1
    Goto lapian_main_findbar
  lapian_main_bar_done:
  StrCpy $R3 "$m1" $R2 0            ; 卸载器路径
  IntOp $R4 $R2 + 1
  StrCpy $R5 "$m1" "" $R4           ; scope
  ${GetParent} "$R3" $R6            ; 安装目录（提示文案用）
  ${If} $silentMode == "1"
    Goto lapian_main_exec
  ${EndIf}
  MessageBox MB_OKCANCEL|MB_ICONQUESTION "卸载 ${TOOL_VERSION} 及安装目录中的离线 AI 资源？$\r$\n$\r$\n安装位置$\r$\n$R6$\r$\n$\r$\n项目和用户数据会保留。" IDOK lapian_main_exec IDCANCEL lapian_main_cancel
  lapian_main_cancel:
    SetErrorLevel 0
    Quit
  lapian_main_exec:
  ${If} $silentMode == "1"
    StrCpy $R5 "$R5 /S"
  ${EndIf}
  ExecWait '"$R3" $R5' $R6
  SetErrorLevel $R6
  Quit
SectionEnd
