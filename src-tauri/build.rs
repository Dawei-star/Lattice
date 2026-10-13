fn main() {
    // 修复测试二进制启动即崩（0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND）：
    // tauri 对话框链路静态导入 comctl32!TaskDialogIndirect，该符号仅由
    // Common-Controls v6（WinSxS 程序集）导出；tauri-build 只把含 v6 依赖的
    // 清单链接进 bins（embed-resource 的 cargo:rustc-link-arg-bins），
    // 测试二进制仍用 Rust 默认清单（无 v6 依赖），进程加载阶段解析导入失败。
    // 故 bins 资源（版本信息/图标）仍由 tauri-build 生成但不含清单，
    // v6 依赖清单由下方统一链接进所有目标（bins/tests/examples/benches）。
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("error while building tauri application");

    #[cfg(windows)]
    {
        // 与 tauri-build 默认清单（windows-app-manifest.xml）内容一致
        const MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>"#;
        let out_dir = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        // 与 tauri-winres 相同的内联清单资源写法（转义 \ 与 "）
        let mut rc = String::from("#pragma code_page(65001)\n1 24\n{\n");
        for line in MANIFEST.lines() {
            let escaped = line.trim().replace('\\', "\\\\").replace('"', "\"\"");
            rc.push_str(&format!("\"{escaped}\"\n"));
        }
        rc.push_str("}\n");
        let rc_path = out_dir.join("manifest.rc");
        std::fs::write(&rc_path, rc).unwrap();
        embed_resource::compile_for_everything(&rc_path, embed_resource::NONE)
            .manifest_required()
            .unwrap();
    }
}
