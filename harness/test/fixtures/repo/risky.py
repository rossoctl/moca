def run(request):
    cmd = request.args.get("cmd")
    return eval(cmd)  # pattern of interest: eval(
