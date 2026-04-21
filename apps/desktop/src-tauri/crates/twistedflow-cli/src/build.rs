use std::path::Path;

pub fn build(
    project: &Path,
    output: &str,
    flow_name: Option<&str>,
    env_name: &str,
    release: bool,
) -> Result<(), String> {
    twistedflow_builder::build(project, output, flow_name, env_name, release).map(|_| ())
}
