; OpenClaw SecurityAudit-CN NSIS 自定义安装脚本

!macro customHeader
  ; 自定义头部
!macroend

!macro preInit
  ; 安装前初始化
!macroend

!macro customInit
  ; 检查 OpenClaw CLI 是否已安装
  ; 如果未安装，提示用户先安装
  nsExec::ExecToStack 'cmd /c openclaw --version'
  Pop $0  ; 退出码
  Pop $1  ; 输出
  
  ${If} $0 != 0
    MessageBox MB_YESNO|MB_ICONQUESTION "未检测到 OpenClaw CLI。$\n$\n请先运行以下命令安装:$\n$\nnpm install -g openclaw$\n$\n是否继续安装？（安装后需要手动安装 OpenClaw CLI）" IDYES continue IDNO abort
    abort:
      Abort
    continue:
  ${EndIf}
!macroend

!macro customInstall
  ; 安装完成后的自定义操作
  ; 创建配置目录
  CreateDirectory "$PROFILE\.openclaw"
!macroend

!macro customUnInstall
  ; 卸载时的自定义操作
!macroend
